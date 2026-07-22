import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { getAccounts as getSimpleFinAccounts } from "./simplefin";
import { readConfig, resolveArchiveAccounts, writeConfig } from "./config";
import { shellQuote } from "./env";
import { detail, formatMilliunits, info, warn } from "./log";
import { toMilliunits } from "./money";
import { parseSelection } from "./link";

export interface SelectArchiveOptions {
    accessUrl: string;
    printOnly?: boolean;
}

export const selectArchive = async (options: SelectArchiveOptions): Promise<string[]> => {
    if (!stdin.isTTY) {
        throw new Error("`select-archive` is interactive and needs a terminal.");
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
        info("SimpleFIN accounts — pick the ones to archive:");
        accountSet.accounts.forEach((account, index) => {
            const org = account.org?.name ?? account.org?.domain ?? "unknown org";
            let balance: string;
            try {
                balance = formatMilliunits(toMilliunits(account.balance));
            } catch {
                balance = account.balance;
            }
            const mark = current === undefined ? "" : current.includes(account.id) ? " ← archived" : "";
            detail(`${String(index + 1).padStart(2)}. ${org} · ${account.name} — ${balance}${mark}`);
        });

        console.log("");
        if (current === undefined) {
            info("Currently archiving ALL accounts.");
        }
        warn("SimpleFIN only serves a rolling 90-day window, so anything you exclude");
        warn("is unrecoverable once it ages out. Excluding is a real, permanent choice.");

        console.log("");
        let picks: number[] | null = null;
        while (picks === null) {
            const answer = await rl.question("Which accounts should be archived? (e.g. 1,3,5 / all) ");
            picks = parseSelection(answer, accountSet.accounts.length);
            if (picks === null) console.log(`  Enter numbers between 1 and ${accountSet.accounts.length}.`);
        }

        if (picks.length === 0) {
            info("Nothing selected — leaving the current setting alone.");
            return current ?? [];
        }

        const chosen = picks.map((i) => accountSet.accounts[i]!);
        const ids = chosen.map((a) => a.id);
        const everything = ids.length === accountSet.accounts.length;

        console.log("");
        info("Will archive:");
        for (const account of chosen) detail(`${account.org?.name ?? "?"} · ${account.name}`);

        const dropped = accountSet.accounts.filter((a) => !ids.includes(a.id));
        if (dropped.length > 0) {
            console.log("");
            info("Will NOT archive:");
            for (const account of dropped) detail(`${account.org?.name ?? "?"} · ${account.name}`);
        }

        console.log("");
        const answer = (await rl.question("Save? [y/N] ")).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") {
            info("Not saved.");
            return ids;
        }

        if (!options.printOnly) {
            if (everything) {
                // Storing an explicit full list would silently stop archiving any account
                // added to the Bridge later. Absent means "everything, including future ones".
                delete config.archiveAccounts;
                info("Archiving all accounts, including any added later.");
            } else {
                config.archiveAccounts = ids;
            }
            writeConfig(config);
            info("Saved.");
        }

        console.log("");
        info("For CI, set this as the SIMPLEFIN_ARCHIVE_ACCOUNTS secret:");
        console.log(`  ${everything ? "all" : ids.join(";")}`);
        console.log("");
        detail("Or:");
        console.log(
            `  gh secret set SIMPLEFIN_ARCHIVE_ACCOUNTS --body ${shellQuote(everything ? "all" : ids.join(";"))}`,
        );

        return ids;
    } finally {
        rl.close();
    }
};
