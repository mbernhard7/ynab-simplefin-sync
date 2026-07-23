import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { API } from "ynab";
import { claimSetupToken } from "./simplefin";
import { readConfig, writeConfig, type Config } from "./config";
import { configEnvPath, shellQuote } from "./env";
import { link } from "./link";
import { selectArchive } from "./selectArchive";
import { detail, info } from "./log";

/** Reads a value without echoing it by muting readline's writer for the prompt. */
const askSecret = async (rl: Interface, query: string): Promise<string> => {
    const internal = rl as unknown as {
        _writeToOutput?: (text: string) => void;
        output?: NodeJS.WritableStream;
    };

    const original = internal._writeToOutput?.bind(rl);
    let muted = false;

    internal._writeToOutput = (text: string) => {
        if (muted) return;
        if (original) original(text);
        else internal.output?.write(text);
    };

    const pending = rl.question(query);
    muted = true;

    try {
        return (await pending).trim();
    } finally {
        muted = false;
        internal._writeToOutput = original;
        stdout.write("\n");
    }
};

const ask = async (rl: Interface, query: string, fallback = ""): Promise<string> => {
    const answer = (await rl.question(query)).trim();
    return answer === "" ? fallback : answer;
};

const confirm = async (rl: Interface, query: string, defaultYes = true): Promise<boolean> => {
    const answer = (await rl.question(`${query} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    if (answer === "") return defaultYes;
    return answer === "y" || answer === "yes";
};

const askOnce = async (query: string): Promise<string> => {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
        return (await rl.question(query)).trim();
    } finally {
        rl.close();
    }
};

const looksLikeAccessUrl = (value: string): boolean => /^https:\/\/[^/]+:[^/]+@/.test(value);

/** Rewrites KEY in place if present, appends otherwise, so re-running setup doesn't duplicate. */
export const upsertEnvFile = (path: string, values: Record<string, string>): void => {
    mkdirSync(dirname(path), { recursive: true });

    let lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];

    for (const [key, value] of Object.entries(values)) {
        const line = `${key}=${value}`;
        const index = lines.findIndex((l) => l.trim().replace(/^export\s+/, "").startsWith(`${key}=`));
        if (index === -1) lines.push(line);
        else lines[index] = line;
    }

    lines = lines.filter((l, i) => l.trim() !== "" || i < lines.length - 1);
    writeFileSync(path, `${lines.join("\n").replace(/\n+$/, "")}\n`);
    chmodSync(path, 0o600);
};

export interface SetupOptions {
    /** Skip the interactive mapping and archive steps. */
    skipLink?: boolean;
}

export const setup = async (options: SetupOptions = {}): Promise<void> => {
    if (!stdin.isTTY) {
        throw new Error("`setup` is interactive and needs a terminal.");
    }

    const rl = createInterface({ input: stdin, output: stdout });
    const envPath = configEnvPath();

    try {
        console.log("");
        info("This sets up ynab-simplefin-sync.");
        detail(`Secrets  → ${envPath} (or your shell, if you'd rather export them)`);
        detail(`Settings → ${dirname(envPath)}/config.json`);
        console.log("");

        let accessUrl = process.env.SIMPLEFIN_ACCESS_URL ?? "";

        if (accessUrl) {
            info("Found an existing SIMPLEFIN_ACCESS_URL.");
            if (!(await confirm(rl, "Keep it?"))) accessUrl = "";
        }

        if (!accessUrl) {
            console.log("");
            info("Paste your SimpleFIN Setup Token, or an Access URL you already have.");
            detail("Setup Tokens are single-use — if this fails, generate a fresh one.");
            const value = await askSecret(rl, "  SimpleFIN token or URL: ");

            if (value === "") throw new Error("A Setup Token or Access URL is required.");

            if (looksLikeAccessUrl(value)) {
                accessUrl = value;
                info("Using the Access URL as given.");
            } else {
                info("Claiming Setup Token...");
                accessUrl = await claimSetupToken(value);
                info("Claimed.");
            }
        }

        let ynabToken = process.env.YNAB_API_TOKEN ?? "";

        if (ynabToken) {
            info("Found an existing YNAB_API_TOKEN.");
            if (!(await confirm(rl, "Keep it?"))) ynabToken = "";
        }

        if (!ynabToken) {
            console.log("");
            info("YNAB personal access token — Settings → Developer Settings → New Access Token.");
            ynabToken = await askSecret(rl, "  YNAB token: ");
            if (ynabToken === "") throw new Error("A YNAB API token is required.");
        }

        const api = new API(ynabToken);
        const config: Config = readConfig();

        info("Fetching your YNAB budgets...");
        // ynab v4 renamed the "budgets" API group to "plans".
        const { data } = await api.plans.getPlans();
        const budgets = data.plans;

        if (budgets.length === 0) throw new Error("That YNAB token can't see any budgets.");

        let budgetId: string;

        if (budgets.length === 1) {
            budgetId = budgets[0]!.id;
            info(`Using your only budget: ${budgets[0]!.name}`);
        } else {
            console.log("");
            info("Budgets:");
            budgets.forEach((budget, index) => {
                const current = budget.id === config.budgetId ? " ← currently configured" : "";
                detail(`${String(index + 1).padStart(2)}. ${budget.name}${current}`);
            });

            let picked: number | undefined;
            while (picked === undefined) {
                const answer = await ask(rl, `  Which budget? (1-${budgets.length}) `);
                const n = Number(answer);
                if (Number.isInteger(n) && n >= 1 && n <= budgets.length) picked = n - 1;
                else console.log(`  Enter a number between 1 and ${budgets.length}.`);
            }
            budgetId = budgets[picked]!.id;
        }

        config.budgetId = budgetId;
        writeConfig(config);
        info(`Saved budget id to ${dirname(envPath)}/config.json`);

        console.log("");
        const save = await confirm(rl, `Save your token and Access URL to ${envPath}?`);

        if (save) {
            upsertEnvFile(envPath, {
                SIMPLEFIN_ACCESS_URL: accessUrl,
                YNAB_API_TOKEN: ynabToken,
            });
            info(`Wrote ${envPath} (mode 600).`);
        } else {
            console.log("");
            info("Export these before running sync — they are not saved anywhere:");
            console.log(`  export SIMPLEFIN_ACCESS_URL=${shellQuote(accessUrl)}`);
            console.log(`  export YNAB_API_TOKEN=${shellQuote(ynabToken)}`);
        }

        process.env.SIMPLEFIN_ACCESS_URL = accessUrl;
        process.env.YNAB_API_TOKEN = ynabToken;
        process.env.YNAB_BUDGET_ID = budgetId;

        if (options.skipLink) {
            console.log("");
            info("Setup complete. Next: `ynab-simplefin-sync link`");
            return;
        }

        console.log("");
        info("Now let's map your accounts.");
    } finally {
        rl.close();
    }

    // link and selectArchive open their own readline, so they run after the one above is closed.
    await link({
        accessUrl: process.env.SIMPLEFIN_ACCESS_URL!,
        ynabToken: process.env.YNAB_API_TOKEN!,
        budgetId: process.env.YNAB_BUDGET_ID!,
    });

    console.log("");
    const wantsArchive = /^y(es)?$/i.test(
        await askOnce("Archive full transaction history for some accounts? Optional, off by default. [y/N] "),
    );
    if (wantsArchive) {
        await selectArchive({ accessUrl: process.env.SIMPLEFIN_ACCESS_URL! });
    }

    console.log("");
    info("Setup complete. Preview before writing anything:");
    console.log("  ynab-simplefin-sync sync --dry-run");
};
