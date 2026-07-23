import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { configPath } from "./config";

/** Minimal `.env` parser: `KEY=value`, `export KEY=value`, quoted values, and comments. */
export const parseEnvFile = (contents: string): Record<string, string> => {
    const result: Record<string, string> = {};

    for (const rawLine of contents.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === "" || line.startsWith("#")) continue;

        const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
        const separator = withoutExport.indexOf("=");
        if (separator <= 0) continue;

        const key = withoutExport.slice(0, separator).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

        let value = withoutExport.slice(separator + 1).trim();

        const quote = value[0];
        if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
            value = value.slice(1, -1);
        } else {
            // Strip trailing comments only, so a `#` inside a URL survives.
            const comment = value.indexOf(" #");
            if (comment !== -1) value = value.slice(0, comment).trim();
        }

        result[key] = value;
    }

    return result;
};

/** The `.env` alongside the config file. */
export const configEnvPath = (): string => join(dirname(configPath()), ".env");

/** `.env` in the current directory, then one alongside the mapping config. */
export const envFileCandidates = (cwd = process.cwd()): string[] => [
    join(cwd, ".env"),
    configEnvPath(),
];

/** Single-quotes a value for copy-pasteable shell commands. */
export const shellQuote = (value: string): string => `'${value.split("'").join(`'\\''`)}'`;

/** Loads `.env` files into process.env without overriding existing variables. Returns paths read. */
export const loadEnv = (candidates = envFileCandidates()): string[] => {
    const loaded: string[] = [];

    for (const path of candidates) {
        if (!existsSync(path)) continue;

        let parsed: Record<string, string>;
        try {
            parsed = parseEnvFile(readFileSync(path, "utf8"));
        } catch {
            continue;
        }

        for (const [key, value] of Object.entries(parsed)) {
            if (process.env[key] === undefined) process.env[key] = value;
        }
        loaded.push(path);
    }

    return loaded;
};
