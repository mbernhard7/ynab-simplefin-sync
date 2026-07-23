import { redactUrl } from "./log";

export interface SimpleFinOrg {
    domain?: string;
    name?: string;
    "sfin-url"?: string;
    url?: string;
    id?: string;
}

export interface SimpleFinAccount {
    id: string;
    name: string;
    currency: string;
    balance: string;
    "available-balance"?: string;
    "balance-date": number;
    org?: SimpleFinOrg;
    conn_id?: string;
}

export interface SimpleFinError {
    code?: string;
    msg?: string;
    conn_id?: string;
    account_id?: string;
}

export interface SimpleFinAccountSet {
    accounts: SimpleFinAccount[];
    /** v2 structured errors. */
    errlist: SimpleFinError[];
    /** v1 string errors, still emitted by the Bridge. */
    errors: string[];
    /** The unmodified response body, kept so the archive loses nothing to our schema. */
    raw?: unknown;
}

/** Exchange a single-use Setup Token (base64 of a claim URL) for a permanent Access URL. */
export const claimSetupToken = async (setupToken: string): Promise<string> => {
    const claimUrl = Buffer.from(setupToken.trim(), "base64").toString("utf8").trim();

    if (!/^https:\/\//.test(claimUrl)) {
        throw new Error("Setup Token did not decode to an https claim URL. Check that it was pasted in full.");
    }

    const res = await fetch(claimUrl, { method: "POST", headers: { "Content-Length": "0" } });

    if (!res.ok) {
        throw new Error(
            `Claim failed (${res.status} ${res.statusText}). Setup Tokens are single-use — ` +
            `if this one was already claimed, generate a new one.`,
        );
    }

    const accessUrl = (await res.text()).trim();

    if (!/^https:\/\/.+:.+@/.test(accessUrl)) {
        throw new Error(`Claim returned something that is not an Access URL: ${accessUrl.slice(0, 80)}`);
    }

    return accessUrl;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

/** An account missing `id`, `balance`, or `balance-date` is dropped rather than defaulted. */
const parseAccountSet = (body: unknown): SimpleFinAccountSet => {
    if (!isRecord(body)) {
        throw new Error("SimpleFIN response was not a JSON object.");
    }

    const errors: string[] = [];
    const errlist: SimpleFinError[] = [];

    for (const e of Array.isArray(body.errors) ? body.errors : []) {
        if (typeof e === "string") errors.push(e);
        else if (isRecord(e)) errlist.push(e as SimpleFinError);
    }
    for (const e of Array.isArray(body.errlist) ? body.errlist : []) {
        if (isRecord(e)) errlist.push(e as SimpleFinError);
    }

    const accounts: SimpleFinAccount[] = [];

    for (const a of Array.isArray(body.accounts) ? body.accounts : []) {
        if (!isRecord(a)) continue;

        const id = typeof a.id === "string" ? a.id : undefined;
        const balance = typeof a.balance === "string" || typeof a.balance === "number" ? String(a.balance) : undefined;
        const balanceDate = typeof a["balance-date"] === "number" ? a["balance-date"] : undefined;

        if (!id || balance === undefined || balanceDate === undefined) {
            errors.push(`Dropped malformed account from response: ${JSON.stringify(a).slice(0, 120)}`);
            continue;
        }

        accounts.push({
            id,
            name: typeof a.name === "string" ? a.name : id,
            currency: typeof a.currency === "string" ? a.currency : "USD",
            balance,
            "available-balance":
                typeof a["available-balance"] === "string" ? a["available-balance"] : undefined,
            "balance-date": balanceDate,
            org: isRecord(a.org) ? (a.org as SimpleFinOrg) : undefined,
            conn_id: typeof a.conn_id === "string" ? a.conn_id : undefined,
        });
    }

    return { accounts, errlist, errors };
};

/** The Bridge caps any requested window at 90 days. */
export const MAX_WINDOW_DAYS = 90;

export interface GetAccountsOptions {
    now?: Date;
    /** Days of transaction history to request. Omit or 0 for balances only. */
    days?: number;
}

export const getAccounts = async (
    accessUrl: string,
    options: GetAccountsOptions = {},
): Promise<SimpleFinAccountSet> => {
    const now = options.now ?? new Date();
    const days = Math.min(Math.max(options.days ?? 0, 0), MAX_WINDOW_DAYS);

    const base = accessUrl.replace(/\/+$/, "");
    const url = new URL(`${base}/accounts`);

    if (days === 0) {
        url.searchParams.set("balances-only", "1");
        url.searchParams.set("start-date", String(Math.floor(now.getTime() / 1000)));
    } else {
        url.searchParams.set("start-date", String(Math.floor(now.getTime() / 1000) - days * 86400));
    }

    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    url.username = "";
    url.password = "";

    if (!username || !password) {
        throw new Error("SIMPLEFIN_ACCESS_URL is missing its embedded credentials.");
    }

    const res = await fetch(url, {
        headers: {
            Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
            Accept: "application/json",
        },
    });

    if (res.status === 403) {
        throw new Error(
            "SimpleFIN returned 403. The Access Token may have been disabled for exceeding the " +
            "request quota (~24/day), or the URL is wrong.",
        );
    }

    if (!res.ok) {
        throw new Error(`SimpleFIN ${redactUrl(url.toString())} returned ${res.status} ${res.statusText}.`);
    }

    const body = await res.json();
    return { ...parseAccountSet(body), raw: body };
};
