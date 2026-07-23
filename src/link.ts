import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { API } from "ynab";
import { getAccounts as getSimpleFinAccounts, type SimpleFinAccount } from "./simplefin";
import { getAccounts as getYnabAccounts } from "./ynab";
import { parseNote, type YnabAccountLike } from "./reconcile";
import {
    configPath,
    formatEnvMap,
    readConfig,
    resolveMappings,
    writeConfig,
    type AccountMapping,
    type Config,
} from "./config";
import { configEnvPath, shellQuote } from "./env";
import { detail, formatMilliunits, info, warn } from "./log";
import { toMilliunits } from "./money";

export interface LinkOptions {
    accessUrl: string;
    ynabToken: string;
    budgetId: string;
    /** Choose the mappings but write nothing. */
    printOnly?: boolean;
}

/** Parses "1,3,5" / "1 3 5" / "all" / "none" into zero-based indices, or null if unusable. */
export const parseSelection = (input: string, max: number): number[] | null => {
    const trimmed = input.trim().toLowerCase();
    if (trimmed === "" || trimmed === "none" || trimmed === "skip") return [];
    if (trimmed === "all") return Array.from({ length: max }, (_, i) => i);

    const indices: number[] = [];
    for (const token of trimmed.split(/[\s,]+/).filter(Boolean)) {
        const n = Number(token);
        if (!Number.isInteger(n) || n < 1 || n > max) return null;
        if (!indices.includes(n - 1)) indices.push(n - 1);
    }
    return indices;
};

const balanceLabel = (account: SimpleFinAccount): string => {
    try {
        return formatMilliunits(toMilliunits(account.balance));
    } catch {
        return `<unparseable: ${account.balance}>`;
    }
};

const orgLabel = (account: SimpleFinAccount): string =>
    account.org?.name ?? account.org?.domain ?? "unknown org";

const similarity = (a: string, b: string): number => {
    const tokens = (s: string) =>
        new Set(
            s
                .toLowerCase()
                .replace(/[^a-z0-9 ]/g, " ")
                .split(/\s+/)
                .filter((t) => t.length > 2),
        );

    const left = tokens(a);
    const right = tokens(b);
    if (left.size === 0 || right.size === 0) return 0;

    let shared = 0;
    for (const token of left) if (right.has(token)) shared += 1;
    return shared / Math.min(left.size, right.size);
};

export const suggestFor = (ynabAccount: YnabAccountLike, candidates: SimpleFinAccount[]): number => {
    let best = -1;
    let bestScore = 0.34;

    candidates.forEach((candidate, index) => {
        const score = similarity(ynabAccount.name, `${orgLabel(candidate)} ${candidate.name}`);
        if (score > bestScore) {
            bestScore = score;
            best = index;
        }
    });

    return best;
};

export const link = async (options: LinkOptions): Promise<AccountMapping[]> => {
    if (!stdin.isTTY) {
        throw new Error("`link` is interactive and needs a terminal. Use `discover` in scripts.");
    }

    const api = new API(options.ynabToken);

    info("Fetching YNAB accounts...");
    const ynabAccounts = (await getYnabAccounts(api, options.budgetId)).filter(
        (a) => !a.deleted && !a.closed,
    );

    info("Fetching SimpleFIN accounts...");
    const accountSet = await getSimpleFinAccounts(options.accessUrl);
    for (const err of accountSet.errors) warn(`SimpleFIN: ${err}`);
    for (const err of accountSet.errlist) warn(`SimpleFIN: ${err.msg ?? err.code ?? "unknown error"}`);

    if (accountSet.accounts.length === 0) {
        throw new Error("SimpleFIN returned no accounts. Connect an institution on the Bridge first.");
    }

    const config = readConfig();
    const existing = resolveMappings(ynabAccounts, { config, env: process.env.SIMPLEFIN_MAP });
    const existingById = new Map(existing.map((m) => [m.ynabAccountId, m]));

    const rl = createInterface({ input: stdin, output: stdout });

    try {
        console.log("");
        info("YNAB accounts:");
        ynabAccounts.forEach((account, index) => {
            const current = existingById.get(account.id);
            const status = current
                ? `mapped via ${current.source} → ${current.simplefinIds.join(" + ")}`
                : "unmapped";
            detail(`${String(index + 1).padStart(2)}. ${account.name} — ${formatMilliunits(account.balance)} — ${status}`);
        });

        console.log("");
        let selected: number[] | null = null;
        while (selected === null) {
            const answer = await rl.question("Which YNAB accounts do you want to map? (e.g. 1,3,5 / all / none) ");
            selected = parseSelection(answer, ynabAccounts.length);
            if (selected === null) console.log(`  Enter numbers between 1 and ${ynabAccounts.length}.`);
        }

        if (selected.length === 0) {
            info("Nothing selected.");
            return [];
        }

        const chosen: AccountMapping[] = [];

        for (const index of selected) {
            const ynabAccount = ynabAccounts[index]!;
            const suggestion = suggestFor(ynabAccount, accountSet.accounts);

            console.log("");
            info(`SimpleFIN accounts for "${ynabAccount.name}":`);
            accountSet.accounts.forEach((account, i) => {
                const mark = i === suggestion ? " ← suggested" : "";
                detail(
                    `${String(i + 1).padStart(2)}. ${orgLabel(account)} · ${account.name} — ` +
                    `${balanceLabel(account)}${mark}`,
                );
            });

            let picks: number[] | null = null;
            while (picks === null) {
                const answer = await rl.question(
                    `  Pick for "${ynabAccount.name}" (comma-separate to sum, blank to skip) `,
                );
                picks = parseSelection(answer, accountSet.accounts.length);
                if (picks === null) console.log(`  Enter numbers between 1 and ${accountSet.accounts.length}.`);
            }

            if (picks.length === 0) {
                warn(`Skipped ${ynabAccount.name}.`);
                continue;
            }

            chosen.push({
                ynabAccountId: ynabAccount.id,
                simplefinIds: picks.map((i) => accountSet.accounts[i]!.id),
                source: "config",
            });
        }

        if (chosen.length === 0) {
            info("Nothing to save.");
            return [];
        }

        const nameById = new Map(ynabAccounts.map((a) => [a.id, a.name]));

        console.log("");
        info("Mappings to save:");
        for (const mapping of chosen) {
            detail(`${nameById.get(mapping.ynabAccountId)} → ${mapping.simplefinIds.join(" + ")}`);
        }

        const shadowed = chosen.filter((m) => {
            const account = ynabAccounts.find((a) => a.id === m.ynabAccountId);
            const noteIds = parseNote(account?.note);
            return noteIds.length > 0 && noteIds.join("+") !== m.simplefinIds.join("+");
        });

        if (shadowed.length > 0) {
            console.log("");
            warn("These YNAB accounts have a SIMPLEFIN: key in their note, which takes precedence");
            warn("over saved mappings. Remove the note key or the saved mapping will be ignored:");
            for (const mapping of shadowed) detail(`${nameById.get(mapping.ynabAccountId)}`);
        }

        console.log("");
        const confirm = (await rl.question("Save? [y/N] ")).trim().toLowerCase();
        if (confirm !== "y" && confirm !== "yes") {
            info("Not saved.");
            return chosen;
        }

        if (!options.printOnly) {
            const updated: Config = { version: 1, mappings: { ...config.mappings } };
            for (const mapping of chosen) {
                updated.mappings[mapping.ynabAccountId] = {
                    name: nameById.get(mapping.ynabAccountId),
                    simplefinIds: mapping.simplefinIds,
                };
            }
            writeConfig(updated);
            info(`Saved ${chosen.length} mapping(s) to ${configPath()}`);
        }

        const all = resolveMappings(ynabAccounts, {
            config: options.printOnly
                ? config
                : {
                    version: 1,
                    mappings: {
                        ...config.mappings,
                        ...Object.fromEntries(
                            chosen.map((m) => [m.ynabAccountId, { simplefinIds: m.simplefinIds }]),
                        ),
                    },
                },
            env: process.env.SIMPLEFIN_MAP,
        });

        const envValue = formatEnvMap(all);
        const envPath = configEnvPath();

        console.log("");
        info("These mappings are picked up automatically on this machine. To use them");
        info("somewhere else — CI, another shell, or without the config file — pick one:");

        console.log("");
        detail("This shell only:");
        console.log(`  export SIMPLEFIN_MAP=${shellQuote(envValue)}`);

        console.log("");
        detail("Every shell, from now on:");
        console.log(`  echo ${shellQuote(`SIMPLEFIN_MAP=${envValue}`)} >> ${shellQuote(envPath)}`);

        console.log("");
        detail("GitHub Actions:");
        console.log(`  gh secret set SIMPLEFIN_MAP --body ${shellQuote(envValue)}`);

        console.log("");
        detail("Or paste into the YNAB account notes instead (notes take precedence):");
        for (const mapping of chosen) {
            detail(`  ${nameById.get(mapping.ynabAccountId)}: SIMPLEFIN:${mapping.simplefinIds.join("+")}`);
        }

        return chosen;
    } finally {
        rl.close();
    }
};
