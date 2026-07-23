import { API, NewTransaction, TransactionClearedStatus, TransactionFlagColor } from "ynab";
import { ADJUSTMENT_IMPORT_ID_PREFIX, type AccountPlan, type YnabAccountLike } from "./reconcile";
import { info, warn } from "./log";

export const PAYEE_NAME = "Balance Adjustment";

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
 * adjustments are excluded by their `import_id` prefix so a fresh adjustment can't make an
 * account look newer than SimpleFIN.
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
        if (t.import_id?.startsWith(ADJUSTMENT_IMPORT_ID_PREFIX)) continue;

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
