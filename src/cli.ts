#!/usr/bin/env node
import { API } from "ynab";
import { claimSetupToken, getAccounts as getSimpleFinAccounts } from "./simplefin";
import { getAccounts as getYnabAccounts } from "./ynab";
import { link } from "./link";
import { selectArchive } from "./selectArchive";
import { setup } from "./setup";
import { configPath, readConfig, resolveBudgetId, resolveMappings } from "./config";
import { toMilliunits } from "./money";
import { detail, error, formatMilliunits, info, warn } from "./log";
import { loadEnv } from "./env";
import { run } from "./run";

const USAGE = `
ynab-simplefin-sync — reconcile YNAB balances against SimpleFIN

Usage: ynab-simplefin-sync <command> [options]

Commands:
  sync            Fetch balances and post one adjustment per account (default)
  setup           Guided first run: credentials, budget, mappings, archive
  link            Map YNAB accounts to SimpleFIN accounts
  discover        List SimpleFIN and YNAB accounts
  claim <token>   Exchange a SimpleFIN setup token for an access URL
  help            Show this help

Options:
  sync    --dry-run  --force  --stale-hours <n>  --threshold <usd>  --archive <dir>
  link    --archive  --print-only
  setup   --skip-link

Environment:
  YNAB_API_TOKEN                required
  SIMPLEFIN_ACCESS_URL         required
  YNAB_BUDGET_ID               required (or "budgetId" in the config)
  SIMPLEFIN_MAP                account mappings (id=ACT-1+ACT-2;id2=ACT-3)
  SIMPLEFIN_ARCHIVE_ACCOUNTS   accounts to archive (ACT-1;ACT-2, or "all"); default none
  ARCHIVE_DIR                  directory for archived snapshots
  DRY_RUN=1                    same as --dry-run

Secrets are also read from ./.env and ~/.config/ynab-simplefin-sync/.env.
`.trim();

const requireEnv = (name: string): string => {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required credential: ${name}. Run \`ynab-simplefin-sync setup\`, or export it.`);
    }
    return value;
};

const requireBudgetId = (): string => {
    const budgetId = resolveBudgetId();
    if (!budgetId) {
        throw new Error(
            `No budget configured. Run \`ynab-simplefin-sync setup\`, set YNAB_BUDGET_ID, or add "budgetId" to ${configPath()}.`,
        );
    }
    return budgetId;
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

const stringFlag = (argv: string[], flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} requires a directory`);
    }
    return value;
};

const discover = async () => {
    const accessUrl = requireEnv("SIMPLEFIN_ACCESS_URL");
    const token = requireEnv("YNAB_API_TOKEN");
    const budgetId = requireBudgetId();

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
        resolveMappings(open, { config: readConfig(), env: process.env.SIMPLEFIN_MAP }).map((m) => [m.ynabAccountId, m]),
    );

    info(`YNAB accounts (${open.length} open):`);
    for (const account of open) {
        const mapping = resolved.get(account.id);
        const status = mapping ? `mapped via ${mapping.source} → ${mapping.simplefinIds.join(" + ")}` : "unmapped";
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
        budgetId: requireBudgetId(),
        archiveDir: stringFlag(argv, "--archive") ?? process.env.ARCHIVE_DIR,
        dryRun: argv.includes("--dry-run") || process.env.DRY_RUN === "1",
        force: argv.includes("--force"),
        staleAfterHours: numericFlag(argv, "--stale-hours"),
        thresholdAbsolute: thresholdUsd === undefined ? undefined : Math.round(thresholdUsd * 1000),
    });

    info(`Done. applied=${summary.applied} failed=${summary.failed} blocked=${summary.blocked}`);

    if (summary.failed > 0 || summary.blocked > 0) {
        process.exitCode = 2;
    }
};

const main = async () => {
    const argv = process.argv.slice(2);
    const command = argv.find((a) => !a.startsWith("--")) ?? "sync";

    for (const path of loadEnv()) detail(`Loaded environment from ${path}`);

    switch (command) {
        case "setup":
            return setup({ skipLink: argv.includes("--skip-link") });
        case "sync":
            return sync(argv);
        case "link": {
            const accessUrl = requireEnv("SIMPLEFIN_ACCESS_URL");
            const printOnly = argv.includes("--print-only");
            await link({ accessUrl, ynabToken: requireEnv("YNAB_API_TOKEN"), budgetId: requireBudgetId(), printOnly });
            if (argv.includes("--archive")) await selectArchive({ accessUrl, printOnly });
            return;
        }
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
