import { API, NewTransaction, TransactionClearedStatus, TransactionFlagColor } from "ynab";
import type { AccountPlan, YnabAccountLike } from "./reconcile";
import { detail, info, warn } from "./log";

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

export type ApplyOutcome = "created" | "updated" | "failed";

export interface ApplyResult {
    plan: AccountPlan;
    outcome: ApplyOutcome;
    error?: string;
}

/**
 * Posts one adjustment per account per day rather than one per run: the day's transaction is
 * looked up by import_id and amended in place, so four runs a day leave a single row behind.
 *
 * `plan.deltaMilliunits` is the gap between the SimpleFIN balance and the *current* YNAB
 * balance, which already includes any earlier adjustment from today — so amending means adding
 * the delta to the existing amount, not replacing it.
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
        return { plan, outcome: "failed", error: err instanceof Error ? err.message : String(err) };
    }
};

export const applyPlans = async (
    api: API,
    budgetId: string,
    plans: AccountPlan[],
): Promise<ApplyResult[]> => {
    const results: ApplyResult[] = [];

    // Sequential on purpose: concurrent writes to the same budget race on import_id uniqueness,
    // and five accounts is not worth the risk of a duplicate adjustment.
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

export const printDiscovery = (accounts: { id: string; name: string; note?: string | null }[]) => {
    info(`YNAB accounts (${accounts.length}):`);
    for (const a of accounts) {
        detail(`${a.name} — note: ${a.note ? JSON.stringify(a.note) : "(none)"}`);
    }
};
