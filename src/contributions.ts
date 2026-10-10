import { createHash } from "node:crypto";
import { toMilliunits } from "./money";
import { localDate, type YnabAccountLike } from "./reconcile";
import type { SimpleFinAccountSet, SimpleFinTransaction } from "./simplefin";

/**
 * Money that arrives in an investment account from payroll — employer contributions and
 * pre-tax deferrals alike — never passes through a checking account, so a balance-only sync
 * absorbs it into `Balance Adjustment` and it disappears from any income or savings-rate
 * figure. These rules pick those deposits out of the SimpleFIN transaction feed and post them
 * as their own transactions, leaving the adjustment to cover only market movement.
 */
export interface ContributionRule {
    /** SimpleFIN account this rule reads. */
    simplefinId: string;
    /** Case-insensitive regex, tested against `description`, then `payee`, then `memo`. */
    match: string;
    /**
     * Which sign in the feed counts as a contribution. Fidelity books 401(k) contributions
     * negative (cash buying into the funds); HSA Bank books payroll deposits positive.
     * Transactions carrying the other sign are ignored, so a withdrawal can never post as income.
     */
    sign: "positive" | "negative";
    /** Payee for the YNAB transaction. Contributions are grouped per account, date and payee. */
    payee: string;
    /** Optional memo. A default naming the source is used when absent. */
    memo?: string;
    /**
     * Calendar window (`MM-DD`) in which a matching deposit may be an employer true-up rather
     * than an ordinary deferral. Nothing in the feed distinguishes the two — Fidelity labels
     * every row `contribution` and splits both across the same funds in the same ratio — so
     * matches here are still posted, but flagged in the memo and in the run log for a human to
     * retag. Guessing would silently mislabel one transaction a year.
     */
    reviewWindow?: { from: string; to: string };
}

export interface ContributionsConfig {
    /**
     * Only feed transactions on or after this date are considered, so contributions already
     * recorded in YNAB by other means are never posted a second time from the feed.
     */
    since?: string;
    rules: ContributionRule[];
}

export interface ContributionPlan {
    ynabAccountId: string;
    ynabAccountName: string;
    simplefinId: string;
    /** `YYYY-MM-DD`. */
    date: string;
    /** Always positive — an inflow. */
    amountMilliunits: number;
    payee: string;
    memo: string;
    importId: string;
    /** True when the deposit fell inside a rule's `reviewWindow`. */
    needsReview: boolean;
    /** Feed transaction ids folded into this plan, for tracing. */
    sourceIds: string[];
}

export const CONTRIBUTION_IMPORT_ID_PREFIX = "SFC:";

/**
 * Nothing writes this any more — the one-off historical backfill that paired each contribution
 * with an offsetting negative is gone, and `sync` needs no offset because it re-reads balances
 * after posting contributions and reconciles the remainder. The prefix stays because those
 * offsets are still in the budget, and `isOwnImportId` must keep recognising them as this tool's
 * own writes rather than activity SimpleFIN has not yet seen.
 */
export const CONTRIBUTION_OFFSET_IMPORT_ID_PREFIX = "SFCO:";

const hash = (value: string, chars: number): string =>
    createHash("sha256").update(value).digest("hex").slice(0, chars);

/**
 * Keyed on account, date and payee rather than the SimpleFIN transaction id, so the same deposit
 * seen twice in the feed collides instead of duplicating. 28 characters, inside YNAB's
 * 36-character limit.
 */
export const buildContributionImportId = (ynabAccountId: string, date: string, payee: string): string =>
    `${CONTRIBUTION_IMPORT_ID_PREFIX}${hash(ynabAccountId, 8)}:${date}:${hash(payee, 4)}`;

const MONTH_DAY = /^\d{2}-\d{2}$/;

/** Inclusive `MM-DD` window membership. Windows that wrap the year end are supported. */
export const inMonthDayWindow = (date: string, from: string, to: string): boolean => {
    if (!MONTH_DAY.test(from) || !MONTH_DAY.test(to)) return false;

    const monthDay = date.slice(5, 10);
    return from <= to ? monthDay >= from && monthDay <= to : monthDay >= from || monthDay <= to;
};

/** `description`, then `payee`, then `memo` — the first non-empty one the connector supplied. */
const subject = (transaction: SimpleFinTransaction): string =>
    [transaction.description, transaction.payee, transaction.memo].find((v) => v && v.trim() !== "") ?? "";

export interface PlanContributionsOptions {
    contributions: ContributionsConfig;
    /** Resolved SimpleFIN → YNAB mappings; a rule for an unmapped account is skipped. */
    mappings: { ynabAccountId: string; simplefinIds: string[] }[];
    /** Used for display names only. */
    ynabAccounts?: YnabAccountLike[];
}

/**
 * Turns the transaction feed into one planned YNAB inflow per account, date and payee. The
 * five per-fund rows Fidelity posts for a single pay period collapse into one transaction.
 */
export const planContributions = (
    accountSet: SimpleFinAccountSet,
    options: PlanContributionsOptions,
): ContributionPlan[] => {
    const { rules, since } = options.contributions;
    if (rules.length === 0) return [];

    const ynabAccountFor = new Map<string, string>();
    for (const mapping of options.mappings) {
        for (const simplefinId of mapping.simplefinIds) {
            ynabAccountFor.set(simplefinId, mapping.ynabAccountId);
        }
    }

    const nameFor = new Map((options.ynabAccounts ?? []).map((a) => [a.id, a.name]));
    const byAccount = new Map(accountSet.accounts.map((a) => [a.id, a]));

    // Grouped by ynabAccountId|date|payee so the per-fund splits become one transaction.
    const groups = new Map<string, ContributionPlan>();

    for (const rule of rules) {
        const account = byAccount.get(rule.simplefinId);
        if (!account?.transactions) continue;

        const ynabAccountId = ynabAccountFor.get(rule.simplefinId);
        if (ynabAccountId === undefined) continue;

        let pattern: RegExp;
        try {
            pattern = new RegExp(rule.match, "i");
        } catch (err) {
            throw new Error(`Contribution rule for ${rule.simplefinId} has an invalid match: ${(err as Error).message}`);
        }

        for (const transaction of account.transactions) {
            if (transaction.pending) continue;
            if (!pattern.test(subject(transaction))) continue;

            let milliunits: number;
            try {
                milliunits = toMilliunits(transaction.amount);
            } catch {
                continue;
            }

            if (milliunits === 0) continue;
            if (rule.sign === "positive" && milliunits < 0) continue;
            if (rule.sign === "negative" && milliunits > 0) continue;

            const date = localDate(new Date((transaction.transacted_at ?? transaction.posted) * 1000));
            if (since !== undefined && date < since) continue;

            const key = `${ynabAccountId}|${date}|${rule.payee}`;
            const existing = groups.get(key);

            if (existing) {
                existing.amountMilliunits += Math.abs(milliunits);
                existing.sourceIds.push(transaction.id);
                continue;
            }

            const needsReview =
                rule.reviewWindow !== undefined &&
                inMonthDayWindow(date, rule.reviewWindow.from, rule.reviewWindow.to);

            groups.set(key, {
                ynabAccountId,
                ynabAccountName: nameFor.get(ynabAccountId) ?? ynabAccountId,
                simplefinId: rule.simplefinId,
                date,
                amountMilliunits: Math.abs(milliunits),
                payee: rule.payee,
                memo: rule.memo ?? `${account.org?.name ?? "SimpleFIN"} · ${account.name}`,
                importId: buildContributionImportId(ynabAccountId, date, rule.payee),
                needsReview,
                sourceIds: [transaction.id],
            });
        }
    }

    const plans = [...groups.values()];

    for (const plan of plans) {
        if (plan.needsReview) {
            plan.memo = `REVIEW (may be an employer true-up) · ${plan.memo}`;
        }
        plan.memo = plan.memo.slice(0, 200);
    }

    return plans.sort((a, b) => a.date.localeCompare(b.date) || a.payee.localeCompare(b.payee));
};

/** Net contribution milliunits per YNAB account — what reconcile's `currentMilliunits` gains. */
export const contributionTotals = (plans: ContributionPlan[]): Map<string, number> => {
    const totals = new Map<string, number>();
    for (const plan of plans) {
        totals.set(plan.ynabAccountId, (totals.get(plan.ynabAccountId) ?? 0) + plan.amountMilliunits);
    }
    return totals;
};

/**
 * Splits planned contributions by whether YNAB already holds their `import_id`. A real run
 * gets this from the bulk endpoint's `duplicate_import_ids`; a dry run has to ask first, or
 * every preview re-adds deposits that were posted days ago.
 */
export const splitAlreadyPosted = (
    plans: ContributionPlan[],
    existingImportIds: ReadonlySet<string>,
): { pending: ContributionPlan[]; present: ContributionPlan[] } => ({
    pending: plans.filter((p) => !existingImportIds.has(p.importId)),
    present: plans.filter((p) => existingImportIds.has(p.importId)),
});
