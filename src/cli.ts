#!/usr/bin/env node
import { API } from "ynab";
import { claimSetupToken, getAccounts as getSimpleFinAccounts } from "./simplefin";
import { getAccounts as getYnabAccounts } from "./ynab";
import { link } from "./link";
import { readConfig, resolveMappings } from "./mapping";
import { toMilliunits } from "./money";
import { detail, error, formatMilliunits, info, warn } from "./log";
import { run } from "./run";

const USAGE = `
ynab-simplefin-sync — reconcile YNAB investment balances against SimpleFIN

  sync                 Fetch balances and post one adjustment per account per day (default)
  link                 Interactively pick YNAB accounts and their SimpleFIN counterparts
  discover             List SimpleFIN and YNAB accounts so they can be mapped
  claim <setup-token>  Exchange a single-use Setup Token for a permanent Access URL

Options (link):
  --print-only         Choose mappings and print them without saving

Options (sync):
  --dry-run            Print the plan without writing to YNAB
  --force              Bypass the large-adjustment safety guard
  --stale-hours <n>    Flag balances older than n hours (default 36)
  --threshold <usd>    Absolute floor for the safety guard (default 25000)

Environment:
  YNAB_API_TOKEN         required for sync and discover
  YNAB_BUDGET_ID         required for sync and discover
  SIMPLEFIN_ACCESS_URL   required for sync, link and discover
  SIMPLEFIN_MAP          optional mappings for CI: id=ACT-1+ACT-2;id2=ACT-3
  DRY_RUN=1              same as --dry-run
`.trim();

const requireEnv = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
};

const numericFlag = (argv: string[], flag: string): number | undefined => {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;

    const raw = argv[index + 1];
    const parsed = Number(raw);
    if (raw === undefined || !Number.isFinite(parsed)) {
        throw new Error(`${flag} requires a numeric value`);
    }
    return parsed;
};

const discover = async () => {
    const accessUrl = requireEnv("SIMPLEFIN_ACCESS_URL");
    const token = requireEnv("YNAB_API_TOKEN");
    const budgetId = requireEnv("YNAB_BUDGET_ID");

    const accountSet = await getSimpleFinAccounts(accessUrl);

    for (const err of accountSet.errors) warn(`SimpleFIN: ${err}`);
    for (const err of accountSet.errlist) {
        warn(`SimpleFIN: ${err.msg ?? err.code ?? "unknown"}${err.account_id ? ` (account ${err.account_id})` : ""}`);
    }

    info(`SimpleFIN accounts (${accountSet.accounts.length}) — paste these ids into YNAB account notes:`);
    for (const account of accountSet.accounts) {
        const org = account.org?.name ?? account.org?.domain ?? "unknown org";
        const asOf = new Date(account["balance-date"] * 1000).toISOString().slice(0, 16).replace("T", " ");
        let balance: string;
        try {
            balance = formatMilliunits(toMilliunits(account.balance));
        } catch {
            balance = `<unparseable: ${account.balance}>`;
        }
        detail(`${org} · ${account.name}`);
        detail(`  SIMPLEFIN:${account.id}`);
        detail(`  ${balance} ${account.currency} as of ${asOf}Z`);
    }

    const ynabAccounts = await getYnabAccounts(new API(token), budgetId);
    const open = ynabAccounts.filter((a) => !a.deleted && !a.closed);
    const resolved = new Map(
        resolveMappings(open, { config: readConfig(), env: process.env.SIMPLEFIN_MAP }).map((m) => [
            m.ynabAccountId,
            m,
        ]),
    );

    info(`YNAB accounts (${open.length} open):`);
    for (const account of open) {
        const mapping = resolved.get(account.id);
        const status = mapping
            ? `mapped via ${mapping.source} → ${mapping.simplefinIds.join(" + ")}`
            : "unmapped";
        detail(`${account.name} — ${formatMilliunits(account.balance)} — ${status}`);
    }

    info("Run `link` to map accounts interactively.");
};

const claim = async (setupToken?: string) => {
    if (!setupToken) throw new Error("Usage: ynab-simplefin-sync claim <setup-token>");

    const accessUrl = await claimSetupToken(setupToken);

    info("Access URL claimed. Store this as the SIMPLEFIN_ACCESS_URL secret — it contains");
    info("credentials, and the Setup Token you just used cannot be claimed again.");
    console.log(accessUrl);
};

const sync = async (argv: string[]) => {
    const thresholdUsd = numericFlag(argv, "--threshold");

    const summary = await run({
        accessUrl: requireEnv("SIMPLEFIN_ACCESS_URL"),
        ynabToken: requireEnv("YNAB_API_TOKEN"),
        budgetId: requireEnv("YNAB_BUDGET_ID"),
        dryRun: argv.includes("--dry-run") || process.env.DRY_RUN === "1",
        force: argv.includes("--force"),
        staleAfterHours: numericFlag(argv, "--stale-hours"),
        thresholdAbsolute: thresholdUsd === undefined ? undefined : Math.round(thresholdUsd * 1000),
    });

    info(
        `Done. applied=${summary.applied} failed=${summary.failed} blocked=${summary.blocked}`,
    );

    // Surface a red CI run for anything that needs a human: a dead connection, a tripped
    // guard, or a rejected write. Silence here would look identical to a healthy sync.
    if (summary.failed > 0 || summary.blocked > 0) {
        process.exitCode = 2;
    }
};

const main = async () => {
    const argv = process.argv.slice(2);
    const command = argv.find((a) => !a.startsWith("--")) ?? "sync";

    switch (command) {
        case "sync":
            return sync(argv);
        case "link":
            await link({
                accessUrl: requireEnv("SIMPLEFIN_ACCESS_URL"),
                ynabToken: requireEnv("YNAB_API_TOKEN"),
                budgetId: requireEnv("YNAB_BUDGET_ID"),
                printOnly: argv.includes("--print-only"),
            });
            return;
        case "discover":
            return discover();
        case "claim":
            return claim(argv[argv.indexOf("claim") + 1]);
        case "help":
            console.log(USAGE);
            return;
        default:
            console.log(USAGE);
            throw new Error(`Unknown command: ${command}`);
    }
};

main().catch((err) => {
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
