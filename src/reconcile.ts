import { createHash } from "node:crypto";
import { toMilliunits } from "./money";
import type { SimpleFinAccount, SimpleFinAccountSet, SimpleFinError } from "./simplefin";

/** The subset of a YNAB account this module needs. `balance` is cleared + uncleared, in milliunits. */
export interface YnabAccountLike {
    id: string;
    name: string;
    note?: string | null;
    balance: number;
    closed?: boolean;
    deleted?: boolean;
}

export type PlanAction = "adjust" | "noop" | "skip";

export type SkipReason =
    | "account-closed"
    | "account-missing"
    | "connection-error"
    | "non-usd"
    | "unparseable-balance"
    | "exceeds-threshold";

export interface AccountPlan {
    ynabAccountId: string;
    ynabAccountName: string;
    simplefinIds: string[];
    action: PlanAction;
    reason?: SkipReason;
    /** Human-readable elaboration of `reason`, or the memo detail for an adjustment. */
    detail?: string;
    /** Sum of the mapped SimpleFIN balances, in milliunits. Absent when skipped. */
    targetMilliunits?: number;
    currentMilliunits: number;
    deltaMilliunits?: number;
    /** Oldest `balance-date` across the mapped accounts, as a Date. */
    balanceDate?: Date;
    stale?: boolean;
    memo?: string;
    importId?: string;
    date?: string;
}

export interface ReconcileOptions {
    /**
     * Pre-resolved account mappings. When omitted, mappings are read from YNAB account notes.
     * `resolveMappings` in ./mapping layers notes over the config file and SIMPLEFIN_MAP.
     */
    mappings?: { ynabAccountId: string; simplefinIds: string[] }[];
    now?: Date;
    /** Flag a balance as stale past this age. Stale balances are still reconciled. */
    staleAfterHours?: number;
    /** Absolute milliunit floor for the large-adjustment guard. */
    thresholdAbsolute?: number;
    /** Fractional share of the current YNAB balance for the large-adjustment guard. */
    thresholdRelative?: number;
    /** Bypass the large-adjustment guard. */
    force?: boolean;
}

const DEFAULTS = {
    staleAfterHours: 36,
    thresholdAbsolute: 25_000 * 1000,
    thresholdRelative: 0.4,
};

const NOTE_PATTERN = /SIMPLEFIN:([A-Za-z0-9_\-+]+)/i;

/**
 * Reads the mapping key out of a YNAB account note. `+` sums several SimpleFIN accounts into
 * one YNAB account, which is what HSA custodians need — they expose the cash side and the
 * investment side as separate accounts.
 */
export const parseNote = (note?: string | null): string[] => {
    const match = NOTE_PATTERN.exec(note ?? "");
    if (!match?.[1]) return [];

    return match[1]
        .split("+")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
};

/** YNAB caps import_id at 36 characters, so the account uuid is hashed down to 8. */
export const buildImportId = (ynabAccountId: string, date: string): string =>
    `SFIN:${createHash("sha256").update(ynabAccountId).digest("hex").slice(0, 8)}:${date}`;

/** Local-time YYYY-MM-DD; YNAB dates are calendar dates, not instants. */
export const localDate = (now: Date): string =>
    new Date(now.getTime() - now.getTimezoneOffset() * 60 * 1000).toISOString().split("T")[0]!;

const errorMentions = (err: SimpleFinError, account: SimpleFinAccount | undefined, id: string): boolean => {
    if (err.account_id && err.account_id === id) return true;
    if (err.conn_id && account?.conn_id && err.conn_id === account.conn_id) return true;
    return false;
};

const describeError = (err: SimpleFinError): string => (err.msg ?? err.code ?? "unknown error").trim();

export const reconcile = (
    ynabAccounts: YnabAccountLike[],
    accountSet: SimpleFinAccountSet,
    options: ReconcileOptions = {},
): AccountPlan[] => {
    const now = options.now ?? new Date();
    const staleAfterHours = options.staleAfterHours ?? DEFAULTS.staleAfterHours;
    const thresholdAbsolute = options.thresholdAbsolute ?? DEFAULTS.thresholdAbsolute;
    const thresholdRelative = options.thresholdRelative ?? DEFAULTS.thresholdRelative;
    const date = localDate(now);

    const byId = new Map(accountSet.accounts.map((a) => [a.id, a]));
    const mapped = options.mappings
        ? new Map(options.mappings.map((m) => [m.ynabAccountId, m.simplefinIds]))
        : undefined;
    const plans: AccountPlan[] = [];

    for (const ynabAccount of ynabAccounts) {
        if (ynabAccount.deleted) continue;

        const simplefinIds = mapped ? mapped.get(ynabAccount.id) ?? [] : parseNote(ynabAccount.note);
        if (simplefinIds.length === 0) continue;

        const base = {
            ynabAccountId: ynabAccount.id,
            ynabAccountName: ynabAccount.name,
            simplefinIds,
            currentMilliunits: ynabAccount.balance,
        };

        if (ynabAccount.closed) {
            plans.push({ ...base, action: "skip", reason: "account-closed" });
            continue;
        }

        let target = 0;
        let oldestBalanceDate: number | undefined;
        let skip: { reason: SkipReason; detail: string } | undefined;
        const orgNames = new Set<string>();

        for (const id of simplefinIds) {
            const account = byId.get(id);

            // An account we asked for but did not get back must never be treated as zero.
            if (!account) {
                skip = {
                    reason: "account-missing",
                    detail: `${id} was not present in the SimpleFIN response`,
                };
                break;
            }

            const relevantErrors = [...accountSet.errlist].filter((e) => errorMentions(e, account, id));
            if (relevantErrors.length > 0) {
                skip = {
                    reason: "connection-error",
                    detail: relevantErrors.map(describeError).join("; "),
                };
                break;
            }

            if (account.currency !== "USD") {
                skip = { reason: "non-usd", detail: `${id} is denominated in ${account.currency}` };
                break;
            }

            try {
                target += toMilliunits(account.balance);
            } catch (err) {
                skip = { reason: "unparseable-balance", detail: (err as Error).message };
                break;
            }

            const balanceDate = account["balance-date"];
            if (oldestBalanceDate === undefined || balanceDate < oldestBalanceDate) {
                oldestBalanceDate = balanceDate;
            }
            if (account.org?.name) orgNames.add(account.org.name);
        }

        if (skip) {
            plans.push({ ...base, action: "skip", ...skip });
            continue;
        }

        const balanceDate = oldestBalanceDate === undefined ? undefined : new Date(oldestBalanceDate * 1000);
        const ageHours =
            balanceDate === undefined ? 0 : (now.getTime() - balanceDate.getTime()) / (1000 * 60 * 60);
        const stale = ageHours > staleAfterHours;
        const delta = target - ynabAccount.balance;

        if (delta === 0) {
            plans.push({ ...base, action: "noop", targetMilliunits: target, deltaMilliunits: 0, balanceDate, stale });
            continue;
        }

        // Guards against an institution briefly reporting a partial or zeroed balance.
        const limit = Math.max(thresholdAbsolute, Math.abs(ynabAccount.balance) * thresholdRelative);
        if (!options.force && Math.abs(delta) > limit) {
            plans.push({
                ...base,
                action: "skip",
                reason: "exceeds-threshold",
                detail: `adjustment exceeds the safety limit; re-run with --force to apply`,
                targetMilliunits: target,
                deltaMilliunits: delta,
                balanceDate,
                stale,
            });
            continue;
        }

        const org = orgNames.size > 0 ? [...orgNames].join(" + ") : "SimpleFIN";
        const asOf = balanceDate ? balanceDate.toISOString().replace("T", " ").slice(0, 16) + "Z" : "unknown";

        plans.push({
            ...base,
            action: "adjust",
            targetMilliunits: target,
            deltaMilliunits: delta,
            balanceDate,
            stale,
            date,
            importId: buildImportId(ynabAccount.id, date),
            memo: `${stale ? "STALE " : ""}${org} · as of ${asOf}`.slice(0, 200),
        });
    }

    return plans;
};
