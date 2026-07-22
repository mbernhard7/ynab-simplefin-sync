import { API } from "ynab";
import { getAccounts as getSimpleFinAccounts } from "./simplefin";
import { parseNote, reconcile, type AccountPlan, type ReconcileOptions } from "./reconcile";
import { applyPlans, getAccounts as getYnabAccounts } from "./ynab";
import { detail, formatMilliunits, info, warn } from "./log";

export interface RunOptions extends ReconcileOptions {
    accessUrl: string;
    ynabToken: string;
    budgetId: string;
    dryRun?: boolean;
}

export interface RunSummary {
    plans: AccountPlan[];
    applied: number;
    failed: number;
    /** Skips caused by a broken upstream connection or a tripped safety guard. */
    blocked: number;
}

const describePlan = (plan: AccountPlan): string => {
    const current = formatMilliunits(plan.currentMilliunits);

    switch (plan.action) {
        case "noop":
            return `${plan.ynabAccountName}: already matches at ${current}.`;
        case "skip":
            return `${plan.ynabAccountName}: SKIPPED (${plan.reason})${plan.detail ? ` — ${plan.detail}` : ""}`;
        case "adjust": {
            const target = formatMilliunits(plan.targetMilliunits ?? 0);
            const delta = formatMilliunits(plan.deltaMilliunits ?? 0);
            const sign = (plan.deltaMilliunits ?? 0) > 0 ? "+" : "";
            return `${plan.ynabAccountName}: ${current} → ${target} (${sign}${delta})${plan.stale ? " [STALE]" : ""}`;
        }
    }
};

export const run = async (options: RunOptions): Promise<RunSummary> => {
    const api = new API(options.ynabToken);

    info("Fetching YNAB accounts...");
    const ynabAccounts = await getYnabAccounts(api, options.budgetId);
    const mapped = ynabAccounts.filter((a) => !a.deleted && parseNote(a.note).length > 0);
    info(`Found ${mapped.length} mapped account(s) out of ${ynabAccounts.length}.`);

    if (mapped.length === 0) {
        warn("No YNAB account note contains a SIMPLEFIN:<id> key. Run `discover` to list ids.");
        return { plans: [], applied: 0, failed: 0, blocked: 0 };
    }

    info("Fetching SimpleFIN balances...");
    const accountSet = await getSimpleFinAccounts(options.accessUrl);
    info(`Fetched ${accountSet.accounts.length} SimpleFIN account(s).`);

    for (const err of accountSet.errors) {
        warn(`SimpleFIN: ${err}`);
    }

    const plans = reconcile(mapped, accountSet, options);

    info("Plan:");
    for (const plan of plans) {
        detail(describePlan(plan));
    }

    const adjustments = plans.filter((p) => p.action === "adjust");
    const blocked = plans.filter(
        (p) => p.action === "skip" && p.reason !== "account-closed",
    ).length;

    if (options.dryRun) {
        info(`Dry run — ${adjustments.length} adjustment(s) withheld.`);
        return { plans, applied: 0, failed: 0, blocked };
    }

    if (adjustments.length === 0) {
        info("Nothing to post.");
        return { plans, applied: 0, failed: 0, blocked };
    }

    info(`Posting ${adjustments.length} adjustment(s) to YNAB...`);
    const results = await applyPlans(api, options.budgetId, adjustments);

    const failed = results.filter((r) => r.outcome === "failed").length;
    return { plans, applied: results.length - failed, failed, blocked };
};
