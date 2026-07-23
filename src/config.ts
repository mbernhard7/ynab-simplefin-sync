import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseNote, type YnabAccountLike } from "./reconcile";

export type MappingSource = "note" | "config" | "env";

export interface AccountMapping {
    ynabAccountId: string;
    simplefinIds: string[];
    source: MappingSource;
}

export interface Config {
    version: 1;
    budgetId?: string;
    mappings: Record<string, { name?: string; simplefinIds: string[] }>;
    /** SimpleFIN account ids to archive. Absent means archive nothing. */
    archiveAccounts?: string[];
}

export const configDir = (): string =>
    join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "ynab-simplefin-sync");

export const configPath = (): string => join(configDir(), "config.json");

const legacyConfigPath = (): string => join(configDir(), "mappings.json");

export const emptyConfig = (): Config => ({ version: 1, mappings: {} });

const parseConfig = (parsed: unknown, path: string): Config => {
    if (typeof parsed !== "object" || parsed === null) {
        throw new Error(`Config at ${path} is not an object.`);
    }

    const config = emptyConfig();

    const budgetId = (parsed as { budgetId?: unknown }).budgetId;
    if (typeof budgetId === "string" && budgetId.length > 0) config.budgetId = budgetId;

    const archive = (parsed as { archiveAccounts?: unknown }).archiveAccounts;
    if (Array.isArray(archive)) {
        const ids = archive.filter((id): id is string => typeof id === "string" && id.length > 0);
        if (ids.length > 0) config.archiveAccounts = ids;
    }

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
    const target = existsSync(path) || path !== configPath() ? path : legacyConfigPath();

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
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
};

/** Format: `<ynabAccountId>=ACT-1+ACT-2;<ynabAccountId>=ACT-3`. Used by SIMPLEFIN_MAP. */
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

export const resolveBudgetId = (config: Config = readConfig()): string | undefined =>
    process.env.YNAB_BUDGET_ID || config.budgetId;

/** `all` returns undefined (archive everything); any other value returns the listed ids. */
export const parseArchiveList = (value?: string | null): string[] | undefined => {
    const trimmed = (value ?? "").trim();
    if (trimmed.toLowerCase() === "all") return undefined;

    return trimmed
        .split(/[;,]/)
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
};

/**
 * Which accounts to archive. `undefined` means every account (including future ones); an empty
 * array means none, which is the default. Environment wins over config.
 */
export const resolveArchiveAccounts = (config: Config = readConfig()): string[] | undefined => {
    const fromEnv = process.env.SIMPLEFIN_ARCHIVE_ACCOUNTS;
    if (fromEnv !== undefined && fromEnv.trim() !== "") return parseArchiveList(fromEnv);
    return config.archiveAccounts ?? [];
};

export interface ResolveSources {
    config?: Config;
    env?: string | null;
}

/** A YNAB account note takes precedence over the config, which takes precedence over the env. */
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

export const shadowedByNote = (ynabAccounts: YnabAccountLike[], config: Config): YnabAccountLike[] =>
    ynabAccounts.filter(
        (a) => !a.deleted && parseNote(a.note).length > 0 && config.mappings[a.id] !== undefined,
    );
