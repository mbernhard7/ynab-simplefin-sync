import { API } from "ynab";
import { getAccounts as getSimpleFinAccounts, MAX_WINDOW_DAYS } from "./simplefin";
import { localDate, reconcile, type AccountPlan, type ReconcileOptions } from "./reconcile";
import { applyPlans, getAccounts as getYnabAccounts, getLastActivityByAccount } from "./ynab";
import { readConfig, resolveArchiveAccounts, resolveMappings } from "./config";
import { writeSnapshot } from "./archive";
import { detail, formatMilliunits, info, warn } from "./log";

export interface RunOptions extends ReconcileOptions {
    accessUrl: string;
    ynabToken: string;
    budgetId: string;
    dryRun?: boolean;
    /** When set, snapshots are written here before reconciling. */
    archiveDir?: string;
    /** SimpleFIN account ids to archive. Omit to use the configured set (none by default). */
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

const writeArchive = (dir: string, accountSet: Parameters<typeof writeSnapshot>[1], only: string[] | undefined): void => {
    if (only !== undefined && only.length === 0) {
        info("Archiving is enabled but no accounts are selected; run `link --archive` to choose.");
        return;
    }

    const snapshot = writeSnapshot(dir, accountSet, new Date(), only);

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
    for (const id of snapshot.missing) {
        warn(`Archive list names ${id}, which SimpleFIN did not return.`);
    }
};

export const run = async (options: RunOptions): Promise<RunSummary> => {
    const api = new API(options.ynabToken);

    info("Fetching YNAB accounts...");
    const ynabAccounts = await getYnabAccounts(api, options.budgetId);

    const config = readConfig();

    const mappings =
        options.mappings ?? resolveMappings(ynabAccounts, { config, env: process.env.SIMPLEFIN_MAP });

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

    const archiving = Boolean(options.archiveDir);
    info(archiving ? `Fetching SimpleFIN balances and ${MAX_WINDOW_DAYS}d of history...` : "Fetching SimpleFIN balances...");
    const accountSet = await getSimpleFinAccounts(options.accessUrl, { days: archiving ? MAX_WINDOW_DAYS : 0 });
    info(`Fetched ${accountSet.accounts.length} SimpleFIN account(s).`);

    for (const err of accountSet.errors) {
        warn(`SimpleFIN: ${err}`);
    }

    // Written before reconciling so a snapshot survives even if the YNAB half fails.
    if (options.archiveDir) {
        try {
            writeArchive(options.archiveDir, accountSet, options.archiveAccounts ?? resolveArchiveAccounts(config));
        } catch (err) {
            warn(`Archive failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // Skip an account whose newest YNAB transaction is later than SimpleFIN's balance-date,
    // so a lagging institution does not revert activity just added in YNAB.
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
