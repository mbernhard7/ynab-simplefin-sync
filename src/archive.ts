import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localDate } from "./reconcile";
import type { SimpleFinAccountSet } from "./simplefin";

export interface SnapshotResult {
    path: string;
    bytes: number;
    accounts: number;
    transactions: number;
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

/**
 * Narrows the response to the given account ids, leaving every other top-level field intact
 * so errors and metadata survive. Returns the ids dropped and the ids asked for but absent —
 * the latter matters because a stale id would otherwise silently archive nothing.
 */
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

const countNested = (raw: unknown, key: "transactions" | "holdings"): number => {
    if (typeof raw !== "object" || raw === null) return 0;
    const accounts = (raw as { accounts?: unknown }).accounts;
    if (!Array.isArray(accounts)) return 0;

    return accounts.reduce<number>((total, account) => {
        const value = (account as Record<string, unknown> | null)?.[key];
        return total + (Array.isArray(value) ? value.length : 0);
    }, 0);
};

/**
 * Writes the untouched response to `<dir>/simplefin-YYYY-MM-DD.json`.
 *
 * Stored uncompressed on purpose. Every run re-fetches the same 90-day window, so consecutive
 * snapshots are near-identical — git deltas them to almost nothing, which gzip would defeat.
 *
 * One file per day, overwritten if the day repeats, so re-running is idempotent and a late
 * run supersedes an earlier one rather than accumulating duplicates.
 */
export const writeSnapshot = (
    dir: string,
    accountSet: SimpleFinAccountSet,
    now = new Date(),
    only?: string[],
): SnapshotResult => {
    const source = accountSet.raw ?? accountSet;

    if (typeof source !== "object" || source === null) {
        throw new Error("Refusing to archive a snapshot that is not an object.");
    }

    const { raw, excluded, missing } = filterAccounts(source, only);

    mkdirSync(dir, { recursive: true });

    const path = join(dir, `simplefin-${localDate(now)}.json`);
    const contents = `${JSON.stringify(raw, null, 2)}\n`;

    // The snapshot holds full transaction history, including card spend.
    writeFileSync(path, contents, { mode: 0o600 });

    return {
        path,
        bytes: Buffer.byteLength(contents),
        accounts: Array.isArray((raw as { accounts?: unknown }).accounts)
            ? ((raw as { accounts: unknown[] }).accounts).length
            : 0,
        transactions: countNested(raw, "transactions"),
        holdings: countNested(raw, "holdings"),
        excluded,
        missing,
    };
};
