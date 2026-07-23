import { API } from "ynab";
import { getAccounts as getSimpleFinAccounts } from "./simplefin";
import { localDate, reconcile, type AccountPlan, type ReconcileOptions } from "./reconcile";
import { applyPlans, getAccounts as getYnabAccounts, getLastActivityByAccount } from "./ynab";
import { readConfig, resolveArchiveAccounts, resolveMappings } from "./config";
import { writeSnapshot } from "./archive";
import { MAX_WINDOW_DAYS } from "./simplefin";
import { detail, formatMilliunits, info, warn } from "./log";

export interface RunOptions extends ReconcileOptions {
    accessUrl: string;
    ynabToken: string;
    budgetId: string;
    dryRun?: boolean;
    /** When set, the full 90-day response is written here before reconciling. */
    archiveDir?: string;
    /** SimpleFIN account ids to archive. Omit to archive everything. */
    archiveAccounts?: string[];
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

    const config = readConfig();

    const mappings =
        options.mappings ??
        resolveMappings(ynabAccounts, { config, env: process.env.SIMPLEFIN_MAP });

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

    // Archiving rides on this one request — the Bridge's quota counts requests, not bytes.
    const archiving = Boolean(options.archiveDir);
    info(archiving ? `Fetching SimpleFIN balances and ${MAX_WINDOW_DAYS}d of history...` : "Fetching SimpleFIN balances...");
    const accountSet = await getSimpleFinAccounts(options.accessUrl, {
        days: archiving ? MAX_WINDOW_DAYS : 0,
    });
    info(`Fetched ${accountSet.accounts.length} SimpleFIN account(s).`);

    for (const err of accountSet.errors) {
        warn(`SimpleFIN: ${err}`);
    }

    // Written before reconciling: a snapshot is worth keeping even if the YNAB half fails,
    // and the 90-day window means anything missed today is unrecoverable later.
    if (options.archiveDir) {
        try {
            const only = options.archiveAccounts ?? resolveArchiveAccounts(config);
            const snapshot = writeSnapshot(options.archiveDir, accountSet, new Date(), only);

            if (snapshot.written.length > 0) {
                const bytes = snapshot.written.reduce((sum, w) => sum + w.bytes, 0);
                info(
                    `Archived ${snapshot.written.length} updated account(s), ${snapshot.transactions} transaction(s), ` +
                    `${snapshot.holdings} holding(s) → ${snapshot.dir} (${Math.round(bytes / 1024)}KB)`,
                );
            } else {
                info("Archive up to date — no account has a newer SimpleFIN balance-date since the last snapshot.");
            }
            if (snapshot.unchanged.length > 0) {
                detail(`${snapshot.unchanged.length} account(s) unchanged since the last snapshot.`);
            }
            if (snapshot.excluded.length > 0) {
                detail(`Excluded ${snapshot.excluded.length} account(s) by configuration.`);
            }
            // A stale id silently archives nothing for that account, and the 90-day window
            // means the omission cannot be repaired later.
            for (const id of snapshot.missing) {
                warn(`Archive list names ${id}, which SimpleFIN did not return.`);
            }
        } catch (err) {
            warn(`Archive failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // SimpleFIN sometimes lags YNAB — the institution hasn't refreshed since a transaction was
    // added in YNAB. Reconciling then would revert that transaction, so fetch each mapped
    // account's most recent activity and let reconcile skip any account YNAB is ahead of. The
    // lookback starts at the oldest mapped balance-date so even a stale account is covered.
    let lastActivityByAccount: Map<string, string> | undefined;
    const mappedSimplefinIds = new Set(mappings.flatMap((m) => m.simplefinIds));
    const balanceDates = accountSet.accounts
        .filter((a) => mappedSimplefinIds.has(a.id))
        .map((a) => a["balance-date"]);

    if (balanceDates.length > 0) {
        const since = localDate(new Date(Math.min(...balanceDates) * 1000));
        try {
            lastActivityByAccount = await getLastActivityByAccount(api, options.budgetId, since);
        } catch (err) {
            warn(`Could not read YNAB transactions for the SimpleFIN-lag guard: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    const plans = reconcile(mapped, accountSet, { ...options, mappings, lastActivityByAccount });

    info("Plan:");
    for (const plan of plans) {
        detail(describePlan(plan));
    }

    const adjustments = plans.filter((p) => p.action === "adjust");
    // "account-closed" is intentional configuration, and "ynab-ahead" is a transient timing skip
    // that resolves itself once SimpleFIN refreshes — neither should turn the run red.
    const blocked = plans.filter(
        (p) => p.action === "skip" && p.reason !== "account-closed" && p.reason !== "ynab-ahead",
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
