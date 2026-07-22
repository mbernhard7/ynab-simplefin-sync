import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseNote, type YnabAccountLike } from "./reconcile";

/**
 * Where a mapping came from. YNAB's API is read-only for accounts (no PATCH endpoint),
 * so `link` cannot write notes — it writes `config`, and `note` stays available for anyone
 * who prefers editing YNAB directly.
 */
export type MappingSource = "note" | "config" | "env";

export interface AccountMapping {
    ynabAccountId: string;
    simplefinIds: string[];
    source: MappingSource;
}

export interface MappingFile {
    version: 1;
    mappings: Record<string, { name?: string; simplefinIds: string[] }>;
}

export const configPath = (): string =>
    join(
        process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
        "ynab-simplefin-sync",
        "mappings.json",
    );

export const readConfig = (path = configPath()): MappingFile => {
    if (!existsSync(path)) return { version: 1, mappings: {} };

    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
        throw new Error(`Mapping file at ${path} is not valid JSON: ${(err as Error).message}`);
    }

    if (typeof parsed !== "object" || parsed === null) {
        throw new Error(`Mapping file at ${path} is not an object.`);
    }

    const raw = (parsed as { mappings?: unknown }).mappings;
    const mappings: MappingFile["mappings"] = {};

    if (typeof raw === "object" && raw !== null) {
        for (const [ynabId, entry] of Object.entries(raw as Record<string, unknown>)) {
            if (typeof entry !== "object" || entry === null) continue;
            const ids = (entry as { simplefinIds?: unknown }).simplefinIds;
            if (!Array.isArray(ids)) continue;

            const simplefinIds = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
            if (simplefinIds.length === 0) continue;

            const name = (entry as { name?: unknown }).name;
            mappings[ynabId] = { simplefinIds, ...(typeof name === "string" ? { name } : {}) };
        }
    }

    return { version: 1, mappings };
};

export const writeConfig = (config: MappingFile, path = configPath()): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
};

/**
 * `SIMPLEFIN_MAP` carries the same data as the config file for environments that have no
 * writable home directory — chiefly GitHub Actions.
 * Format: `<ynabAccountId>=ACT-1+ACT-2;<ynabAccountId>=ACT-3`
 */
export const parseEnvMap = (value?: string | null): Record<string, string[]> => {
    const result: Record<string, string[]> = {};
    if (!value) return result;

    for (const entry of value.split(";")) {
        const trimmed = entry.trim();
        if (!trimmed) continue;

        const separator = trimmed.indexOf("=");
        if (separator === -1) {
            throw new Error(`SIMPLEFIN_MAP entry is missing '=': ${trimmed}`);
        }

        const ynabId = trimmed.slice(0, separator).trim();
        const ids = trimmed
            .slice(separator + 1)
            .split("+")
            .map((id) => id.trim())
            .filter((id) => id.length > 0);

        if (!ynabId || ids.length === 0) {
            throw new Error(`SIMPLEFIN_MAP entry is incomplete: ${trimmed}`);
        }

        result[ynabId] = ids;
    }

    return result;
};

export const formatEnvMap = (mappings: AccountMapping[]): string =>
    mappings.map((m) => `${m.ynabAccountId}=${m.simplefinIds.join("+")}`).join(";");

export interface ResolveSources {
    config?: MappingFile;
    env?: string | null;
}

/**
 * The note wins when both are present. It is the only mapping visible from inside YNAB, so
 * letting an invisible JSON file silently override it would make a wrong balance very hard
 * to explain. `link` warns when it is about to be shadowed this way.
 */
export const resolveMappings = (
    ynabAccounts: YnabAccountLike[],
    sources: ResolveSources = {},
): AccountMapping[] => {
    const fromEnv = parseEnvMap(sources.env);
    const fromConfig = sources.config?.mappings ?? {};
    const resolved: AccountMapping[] = [];

    for (const account of ynabAccounts) {
        if (account.deleted) continue;

        const noteIds = parseNote(account.note);
        if (noteIds.length > 0) {
            resolved.push({ ynabAccountId: account.id, simplefinIds: noteIds, source: "note" });
            continue;
        }

        const configIds = fromConfig[account.id]?.simplefinIds;
        if (configIds && configIds.length > 0) {
            resolved.push({ ynabAccountId: account.id, simplefinIds: configIds, source: "config" });
            continue;
        }

        const envIds = fromEnv[account.id];
        if (envIds && envIds.length > 0) {
            resolved.push({ ynabAccountId: account.id, simplefinIds: envIds, source: "env" });
        }
    }

    return resolved;
};

/** Accounts whose config mapping is being overridden by a note — worth telling the user about. */
export const shadowedByNote = (
    ynabAccounts: YnabAccountLike[],
    config: MappingFile,
): YnabAccountLike[] =>
    ynabAccounts.filter(
        (a) => !a.deleted && parseNote(a.note).length > 0 && config.mappings[a.id] !== undefined,
    );
