import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SimpleFinAccountSet } from "./simplefin";

export interface WrittenAccount {
    id: string;
    path: string;
    bytes: number;
    /** The account's `balance-date`, i.e. when SimpleFIN last refreshed it. */
    balanceDate: number | undefined;
}

export interface SnapshotResult {
    dir: string;
    /** Accounts written this run — new, or refreshed by SimpleFIN since the last snapshot. */
    written: WrittenAccount[];
    /** Account ids skipped because this exact `balance-date` was already archived. */
    unchanged: string[];
    /** Total transactions across the written accounts. */
    transactions: number;
    /** Total holdings across the written accounts. */
    holdings: number;
    /** Account ids present in the response but excluded by the filter. */
    excluded: string[];
    /** Configured ids that the response did not contain — usually a stale or mistyped id. */
    missing: string[];
}

const accountId = (account: unknown): string | undefined => {
    const id = (account as { id?: unknown } | null)?.id;
    return typeof id === "string" ? id : undefined;
};

const balanceDate = (account: unknown): number | undefined => {
    const bd = (account as { "balance-date"?: unknown } | null)?.["balance-date"];
    return typeof bd === "number" ? bd : undefined;
};

const nestedCount = (account: unknown, key: "transactions" | "holdings"): number => {
    const value = (account as Record<string, unknown> | null)?.[key];
    return Array.isArray(value) ? value.length : 0;
};

/** Narrows the response to the given ids. Returns the ids dropped and the ids asked for but absent. */
export const filterAccounts = (
    raw: unknown,
    only: string[] | undefined,
): { raw: unknown; excluded: string[]; missing: string[] } => {
    if (!only || typeof raw !== "object" || raw === null) {
        return { raw, excluded: [], missing: [] };
    }

    const accounts = (raw as { accounts?: unknown }).accounts;
    if (!Array.isArray(accounts)) return { raw, excluded: [], missing: [] };

    const wanted = new Set(only);
    const kept = accounts.filter((a) => {
        const id = accountId(a);
        return id !== undefined && wanted.has(id);
    });

    const excluded = accounts
        .map(accountId)
        .filter((id): id is string => id !== undefined && !wanted.has(id));

    const present = new Set(accounts.map(accountId));
    const missing = only.filter((id) => !present.has(id));

    return { raw: { ...(raw as Record<string, unknown>), accounts: kept }, excluded, missing };
};

const safeSegment = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, "_");

/** Balance timestamp as a filename-safe UTC string, e.g. 2026-07-23T12-00-00Z. */
const stampFor = (bd: number | undefined): string =>
    bd === undefined ? "undated" : new Date(bd * 1000).toISOString().slice(0, 19).replace(/:/g, "-") + "Z";

/**
 * Writes each account's raw object to `<dir>/<account-id>/<balance-date>.json`. Keyed by
 * `balance-date`, the write is skipped when that account already has a file for the same
 * timestamp, so a run only produces files for accounts SimpleFIN has refreshed.
 */
export const writeSnapshot = (
    dir: string,
    accountSet: SimpleFinAccountSet,
    _now = new Date(),
    only?: string[],
): SnapshotResult => {
    const source = accountSet.raw ?? accountSet;

    if (typeof source !== "object" || source === null) {
        throw new Error("Refusing to archive a snapshot that is not an object.");
    }

    const { raw, excluded, missing } = filterAccounts(source, only);
    const accounts = Array.isArray((raw as { accounts?: unknown }).accounts)
        ? (raw as { accounts: unknown[] }).accounts
        : [];

    const written: WrittenAccount[] = [];
    const unchanged: string[] = [];
    let transactions = 0;
    let holdings = 0;

    for (const account of accounts) {
        const id = accountId(account);
        if (id === undefined) continue;

        const bd = balanceDate(account);
        const accountDir = join(dir, safeSegment(id));
        const path = join(accountDir, `${stampFor(bd)}.json`);

        if (existsSync(path)) {
            unchanged.push(id);
            continue;
        }

        mkdirSync(accountDir, { recursive: true });
        const contents = `${JSON.stringify(account, null, 2)}\n`;
        // Contains full transaction history; keep it owner-only.
        writeFileSync(path, contents, { mode: 0o600 });

        written.push({ id, path, bytes: Buffer.byteLength(contents), balanceDate: bd });
        transactions += nestedCount(account, "transactions");
        holdings += nestedCount(account, "holdings");
    }

    return { dir, written, unchanged, transactions, holdings, excluded, missing };
};
