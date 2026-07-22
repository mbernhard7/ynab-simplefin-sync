import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseNote, type YnabAccountLike } from "./reconcile";

/**
 * Where a mapping came from. YNAB's API is read-only for accounts (no PATCH endpoint),
 * so `link` cannot write notes — it writes the config, and `note` stays available for anyone
 * who prefers editing YNAB directly.
 */
export type MappingSource = "note" | "config" | "env";

export interface AccountMapping {
    ynabAccountId: string;
    simplefinIds: string[];
    source: MappingSource;
}

/**
 * Structural settings only. Secrets (YNAB_API_TOKEN, SIMPLEFIN_ACCESS_URL) deliberately never
 * land here — they belong in the environment or the sibling `.env`, which is written 0600.
 */
export interface Config {
    version: 1;
    budgetId?: string;
    mappings: Record<string, { name?: string; simplefinIds: string[] }>;
}

export const configDir = (): string =>
    join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "ynab-simplefin-sync");

export const configPath = (): string => join(configDir(), "config.json");

/** Pre-2.1 name, when the file only held mappings. Read once so upgrades don't lose data. */
const legacyConfigPath = (): string => join(configDir(), "mappings.json");

export const emptyConfig = (): Config => ({ version: 1, mappings: {} });

const parseConfig = (parsed: unknown, path: string): Config => {
    if (typeof parsed !== "object" || parsed === null) {
        throw new Error(`Config at ${path} is not an object.`);
    }

    const config = emptyConfig();

    const budgetId = (parsed as { budgetId?: unknown }).budgetId;
    if (typeof budgetId === "string" && budgetId.length > 0) config.budgetId = budgetId;

    const raw = (parsed as { mappings?: unknown }).mappings;
    if (typeof raw === "object" && raw !== null) {
        for (const [ynabId, entry] of Object.entries(raw as Record<string, unknown>)) {
            if (typeof entry !== "object" || entry === null) continue;

            const ids = (entry as { simplefinIds?: unknown }).simplefinIds;
            if (!Array.isArray(ids)) continue;

            const simplefinIds = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
            if (simplefinIds.length === 0) continue;

            const name = (entry as { name?: unknown }).name;
            config.mappings[ynabId] = {
                simplefinIds,
                ...(typeof name === "string" ? { name } : {}),
            };
        }
    }

    return config;
};

export const readConfig = (path = configPath()): Config => {
    // The legacy fallback applies only to the default location. Honoring it for an explicit
    // path would mean a caller asking for a file that doesn't exist silently gets the user's
    // real config instead of an empty one.
    const target =
        existsSync(path) || path !== configPath() ? path : legacyConfigPath();

    if (!existsSync(target)) return emptyConfig();

    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(target, "utf8"));
    } catch (err) {
        throw new Error(`Config at ${target} is not valid JSON: ${(err as Error).message}`);
    }

    return parseConfig(parsed, target);
};

export const writeConfig = (config: Config, path = configPath()): void => {
    mkdirSync(dirname(path), { recursive: true });
    // Names the user's accounts; no reason for it to be world-readable.
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
};

/**
 * `SIMPLEFIN_MAP` carries the same mappings as the config for environments with no writable
 * home directory — chiefly GitHub Actions.
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

/** Environment wins, so CI and one-off overrides never need the config file touched. */
export const resolveBudgetId = (config: Config = readConfig()): string | undefined =>
    process.env.YNAB_BUDGET_ID || config.budgetId;

export interface ResolveSources {
    config?: Config;
    env?: string | null;
}

/**
 * The note wins when both are present. It is the only mapping visible from inside YNAB, so
 * letting an invisible config silently override it would make a wrong balance very hard to
 * explain. `link` warns when it is about to be shadowed this way.
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
export const shadowedByNote = (ynabAccounts: YnabAccountLike[], config: Config): YnabAccountLike[] =>
    ynabAccounts.filter(
        (a) => !a.deleted && parseNote(a.note).length > 0 && config.mappings[a.id] !== undefined,
    );
