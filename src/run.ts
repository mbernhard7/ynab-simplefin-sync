import { API } from "ynab";
import { getAccounts as getSimpleFinAccounts } from "./simplefin";
import { reconcile, type AccountPlan, type ReconcileOptions } from "./reconcile";
import { applyPlans, getAccounts as getYnabAccounts } from "./ynab";
import { readConfig, resolveMappings } from "./mapping";
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

    const mappings =
        options.mappings ??
        resolveMappings(ynabAccounts, { config: readConfig(), env: process.env.SIMPLEFIN_MAP });

    const bySource = mappings.reduce<Record<string, number>>((acc, m) => {
        const source = "source" in m ? String(m.source) : "note";
        acc[source] = (acc[source] ?? 0) + 1;
        return acc;
    }, {});

    info(
        `Found ${mappings.length} mapped account(s) out of ${ynabAccounts.length}` +
        `${Object.keys(bySource).length > 0 ? ` (${Object.entries(bySource).map(([k, v]) => `${v} via ${k}`).join(", ")})` : ""}.`,
    );

    if (mappings.length === 0) {
        warn("No accounts are mapped. Run `link` to pick them interactively, or `discover` to list ids.");
        return { plans: [], applied: 0, failed: 0, blocked: 0 };
    }

    const mappedIds = new Set(mappings.map((m) => m.ynabAccountId));
    const mapped = ynabAccounts.filter((a) => mappedIds.has(a.id));

    info("Fetching SimpleFIN balances...");
    const accountSet = await getSimpleFinAccounts(options.accessUrl);
    info(`Fetched ${accountSet.accounts.length} SimpleFIN account(s).`);

    for (const err of accountSet.errors) {
        warn(`SimpleFIN: ${err}`);
    }

    const plans = reconcile(mapped, accountSet, { ...options, mappings });

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
