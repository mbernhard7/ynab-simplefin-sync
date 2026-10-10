import { API, NewTransaction, TransactionClearedStatus, TransactionFlagColor } from "ynab";
import { ADJUSTMENT_IMPORT_ID_PREFIX, type AccountPlan, type YnabAccountLike } from "./reconcile";
import {
    CONTRIBUTION_IMPORT_ID_PREFIX,
    CONTRIBUTION_OFFSET_IMPORT_ID_PREFIX,
} from "./contributions";
import { info, warn } from "./log";

export const PAYEE_NAME = "Balance Adjustment";

/** Every import_id prefix this tool writes. All of them are its own activity, not a human's. */
const OWN_IMPORT_ID_PREFIXES = [
    ADJUSTMENT_IMPORT_ID_PREFIX,
    CONTRIBUTION_IMPORT_ID_PREFIX,
    CONTRIBUTION_OFFSET_IMPORT_ID_PREFIX,
];

const isOwnImportId = (importId?: string | null): boolean =>
    importId !== undefined && importId !== null && OWN_IMPORT_ID_PREFIXES.some((p) => importId.startsWith(p));

export const getAccounts = async (api: API, budgetId: string): Promise<YnabAccountLike[]> => {
    const { data } = await api.accounts.getAccounts(budgetId);
    return data.accounts.map((a) => ({
        id: a.id,
        name: a.name,
        note: a.note,
        balance: a.balance,
        closed: a.closed,
        deleted: a.deleted,
    }));
};

/**
 * Most recent transaction date per account (`YYYY-MM-DD`) since `sinceDate`. This tool's own
 * writes are excluded by their `import_id` prefix so a fresh adjustment can't make an account
 * look newer than SimpleFIN. Contributions are excluded for the same reason — they are read
 * out of the feed, so they can never be activity SimpleFIN has not yet seen.
 */
export const getLastActivityByAccount = async (
    api: API,
    budgetId: string,
    sinceDate: string,
): Promise<Map<string, string>> => {
    const { data } = await api.transactions.getTransactions(budgetId, sinceDate);
    const latest = new Map<string, string>();

    for (const t of data.transactions) {
        if (t.deleted) continue;
        if (isOwnImportId(t.import_id)) continue;

        const current = latest.get(t.account_id);
        if (current === undefined || t.date > current) latest.set(t.account_id, t.date);
    }

    return latest;
};

export type ApplyOutcome = "created" | "updated" | "failed";

export interface ApplyResult {
    plan: AccountPlan;
    outcome: ApplyOutcome;
    error?: string;
}

/** Reads the HTTP status and YNAB's structured error detail out of whatever the SDK throws. */
export const describeApiError = async (err: unknown): Promise<string> => {
    const response = (err as { response?: Response } | null)?.response;
    if (response && typeof response.status === "number") {
        let detail = "";
        try {
            const body = (await response.clone().json()) as { error?: { name?: string; detail?: string; id?: string } };
            detail = body.error?.detail ?? body.error?.name ?? body.error?.id ?? "";
        } catch {
            // Body was empty or not JSON.
        }
        return `YNAB API ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`.trim();
    }

    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
};

/**
 * Posts one adjustment per account per day: the day's transaction is looked up by `import_id`
 * and amended in place. `plan.deltaMilliunits` is the gap against the current YNAB balance, so
 * amending adds the delta to the existing amount rather than replacing it.
 */
export const applyPlan = async (api: API, budgetId: string, plan: AccountPlan): Promise<ApplyResult> => {
    if (plan.action !== "adjust" || plan.deltaMilliunits === undefined || !plan.importId || !plan.date) {
        throw new Error(`applyPlan called with a non-adjustable plan for ${plan.ynabAccountName}`);
    }

    try {
        const { data } = await api.transactions.getTransactionsByAccount(
            budgetId,
            plan.ynabAccountId,
            plan.date,
        );

        const existing = data.transactions.find((t) => t.import_id === plan.importId && !t.deleted);

        if (existing) {
            await api.transactions.updateTransaction(budgetId, existing.id, {
                transaction: {
                    account_id: plan.ynabAccountId,
                    date: plan.date,
                    amount: existing.amount + plan.deltaMilliunits,
                    payee_name: PAYEE_NAME,
                    memo: plan.memo,
                    cleared: TransactionClearedStatus.Cleared,
                    approved: true,
                    flag_color: TransactionFlagColor.Blue,
                },
            });
            return { plan, outcome: "updated" };
        }

        const transaction: NewTransaction = {
            account_id: plan.ynabAccountId,
            date: plan.date,
            amount: plan.deltaMilliunits,
            payee_name: PAYEE_NAME,
            memo: plan.memo,
            cleared: TransactionClearedStatus.Cleared,
            approved: true,
            flag_color: TransactionFlagColor.Blue,
            import_id: plan.importId,
        };

        await api.transactions.createTransaction(budgetId, { transaction });
        return { plan, outcome: "created" };
    } catch (err) {
        return { plan, outcome: "failed", error: await describeApiError(err) };
    }
};

/** One YNAB transaction to create. */
/** Every `import_id` on a live transaction since `sinceDate`, for a dry run to dedupe against. */
export const getExistingImportIds = async (
    api: API,
    budgetId: string,
    sinceDate: string,
): Promise<Set<string>> => {
    const { data } = await api.transactions.getTransactions(budgetId, sinceDate);
    return new Set(data.transactions.filter((t) => !t.deleted && t.import_id).map((t) => t.import_id as string));
};

export interface PostableTransaction {
    ynabAccountId: string;
    date: string;
    /** Signed milliunits: positive for a contribution, negative for its offset. */
    amountMilliunits: number;
    payee: string;
    memo: string;
    importId: string;
    flagColor?: TransactionFlagColor;
}

export interface PostResult {
    created: number;
    /** Already present, matched by `import_id`. Re-running is a no-op, not a duplicate row. */
    duplicate: number;
    failed: number;
    errors: string[];
}

/** YNAB's bulk endpoint takes a large array; chunking keeps a single failure from losing the lot. */
const POST_CHUNK_SIZE = 100;

const toNewTransaction = (item: PostableTransaction): NewTransaction => ({
    account_id: item.ynabAccountId,
    date: item.date,
    amount: item.amountMilliunits,
    payee_name: item.payee,
    memo: item.memo.slice(0, 200),
    cleared: TransactionClearedStatus.Cleared,
    approved: true,
    flag_color: item.flagColor ?? TransactionFlagColor.Green,
    import_id: item.importId,
});

/**
 * Creates transactions in bulk, keyed by `import_id`. An id YNAB already holds comes back in
 * `duplicate_import_ids` rather than creating a second row, which is what makes a re-run of the
 * daily sync safe to repeat.
 */
export const postTransactions = async (
    api: API,
    budgetId: string,
    items: PostableTransaction[],
): Promise<PostResult> => {
    const result: PostResult = { created: 0, duplicate: 0, failed: 0, errors: [] };

    for (let offset = 0; offset < items.length; offset += POST_CHUNK_SIZE) {
        const chunk = items.slice(offset, offset + POST_CHUNK_SIZE);

        try {
            const { data } = await api.transactions.createTransactions(budgetId, {
                transactions: chunk.map(toNewTransaction),
            });

            // Counted from the ids YNAB hands back, never inferred from the chunk size. A run that
            // assumed "accepted with no duplicates" meant "all created" once reported 172 writes
            // for 144 actual rows, and a caller trusted that number. Anything the response does
            // not account for is a failure, not a silent success.
            const duplicates = new Set(data.duplicate_import_ids ?? []);
            const created = data.transaction_ids?.length ?? 0;

            result.duplicate += duplicates.size;
            result.created += created;

            const unaccounted = chunk.length - created - duplicates.size;
            if (unaccounted > 0) {
                result.failed += unaccounted;
                result.errors.push(
                    `YNAB accepted ${chunk.length} transaction(s) but reported ${created} created ` +
                    `and ${duplicates.size} duplicate — ${unaccounted} unaccounted for.`,
                );
            }
        } catch (err) {
            result.failed += chunk.length;
            result.errors.push(await describeApiError(err));
        }
    }

    return result;
};

export const applyPlans = async (
    api: API,
    budgetId: string,
    plans: AccountPlan[],
): Promise<ApplyResult[]> => {
    const results: ApplyResult[] = [];

    // Sequential: concurrent writes to one budget race on import_id uniqueness.
    for (const plan of plans) {
        const result = await applyPlan(api, budgetId, plan);
        if (result.outcome === "failed") {
            warn(`${plan.ynabAccountName}: ${result.error}`);
        } else {
            info(`${plan.ynabAccountName}: ${result.outcome} adjustment.`);
        }
        results.push(result);
    }

    return results;
};
