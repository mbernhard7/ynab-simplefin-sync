import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { getAccounts as getSimpleFinAccounts } from "./simplefin";
import { readConfig, resolveArchiveAccounts, writeConfig } from "./config";
import { shellQuote } from "./env";
import { detail, formatMilliunits, info } from "./log";
import { toMilliunits } from "./money";
import { parseSelection } from "./link";

export interface SelectArchiveOptions {
    accessUrl: string;
    printOnly?: boolean;
}

export const selectArchive = async (options: SelectArchiveOptions): Promise<string[]> => {
    if (!stdin.isTTY) {
        throw new Error("Archive selection is interactive and needs a terminal.");
    }

    info("Fetching SimpleFIN accounts...");
    const accountSet = await getSimpleFinAccounts(options.accessUrl);

    if (accountSet.accounts.length === 0) {
        throw new Error("SimpleFIN returned no accounts.");
    }

    const config = readConfig();
    const current = resolveArchiveAccounts(config);
    const rl = createInterface({ input: stdin, output: stdout });

    try {
        console.log("");
        info("Archiving saves each account's full transaction history to a directory you choose");
        info("(--archive / ARCHIVE_DIR). It is optional and off by default.");

        console.log("");
        info("SimpleFIN accounts:");
        accountSet.accounts.forEach((account, index) => {
            const org = account.org?.name ?? account.org?.domain ?? "unknown org";
            let balance: string;
            try {
                balance = formatMilliunits(toMilliunits(account.balance));
            } catch {
                balance = account.balance;
            }
            const archived = current === undefined || current.includes(account.id);
            detail(`${String(index + 1).padStart(2)}. ${org} · ${account.name} — ${balance}${archived ? " ← archived" : ""}`);
        });

        console.log("");
        let picks: number[] | null = null;
        while (picks === null) {
            const answer = await rl.question("Which accounts should be archived? (e.g. 1,3,5 / all / none) ");
            picks = parseSelection(answer, accountSet.accounts.length);
            if (picks === null) console.log(`  Enter numbers between 1 and ${accountSet.accounts.length}.`);
        }

        if (picks.length === 0) {
            if (!options.printOnly) {
                delete config.archiveAccounts;
                writeConfig(config);
            }
            info("No accounts will be archived.");
            return [];
        }

        const chosen = picks.map((i) => accountSet.accounts[i]!);
        const ids = chosen.map((a) => a.id);

        console.log("");
        info("Will archive:");
        for (const account of chosen) detail(`${account.org?.name ?? "?"} · ${account.name}`);

        console.log("");
        const answer = (await rl.question("Save? [y/N] ")).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") {
            info("Not saved.");
            return ids;
        }

        if (!options.printOnly) {
            config.archiveAccounts = ids;
            writeConfig(config);
            info("Saved.");
        }

        console.log("");
        info("For CI, set the SIMPLEFIN_ARCHIVE_ACCOUNTS secret:");
        console.log(`  gh secret set SIMPLEFIN_ARCHIVE_ACCOUNTS --body ${shellQuote(ids.join(";"))}`);
        if (ids.length === accountSet.accounts.length) {
            detail("Or use `all` to also archive accounts you connect later.");
        }

        return ids;
    } finally {
        rl.close();
    }
};
