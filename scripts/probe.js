#!/usr/bin/env node
/**
 * Dumps everything SimpleFIN returns, for exploring what the Bridge actually provides
 * beyond the documented v2 spec (holdings, payee/memo/mcc on transactions, and so on).
 *
 *   node scripts/probe.js [--days 90] [--out /path/to/raw.json] [--quiet]
 *
 * Costs one request against SimpleFIN's ~24/day quota. Not shipped in the npm package.
 * The raw dump contains your real financial data — write it somewhere you're happy to have it.
 */
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { loadEnv } = require("../dist/env");

const arg = (flag, fallback) => {
    const i = process.argv.indexOf(flag);
    return i === -1 ? fallback : process.argv[i + 1];
};

const days = Math.min(Number(arg("--days", 90)), 90); // The Bridge caps windows at 90 days.
const outPath = arg("--out", join(tmpdir(), "simplefin-raw.json"));
const quiet = process.argv.includes("--quiet");

loadEnv();

const accessUrl = process.env.SIMPLEFIN_ACCESS_URL;
if (!accessUrl) {
    console.error("SIMPLEFIN_ACCESS_URL not set. Export it, or put it in ~/.config/ynab-simplefin-sync/.env");
    process.exit(1);
}

const url = new URL(`${accessUrl.replace(/\/+$/, "")}/accounts`);
url.searchParams.set("start-date", String(Math.floor(Date.now() / 1000) - days * 86400));

const user = decodeURIComponent(url.username);
const pass = decodeURIComponent(url.password);
url.username = "";
url.password = "";

const fmtDate = (unix) =>
    unix ? new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 19) : String(unix);

const keysOf = (objects) => {
    const keys = new Set();
    for (const o of objects) if (o && typeof o === "object") Object.keys(o).forEach((k) => keys.add(k));
    return [...keys].sort();
};

/** Prints an array of like-shaped objects as an aligned table. */
const table = (rows, indent = "    ") => {
    if (rows.length === 0) return;

    const cols = keysOf(rows);
    const width = Object.fromEntries(
        cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length))]),
    );

    console.log(indent + cols.map((c) => c.padEnd(width[c])).join("  "));
    console.log(indent + cols.map((c) => "-".repeat(width[c])).join("  "));
    for (const row of rows) {
        console.log(indent + cols.map((c) => String(row[c] ?? "").padEnd(width[c])).join("  "));
    }
};

(async () => {
    const res = await fetch(url, {
        headers: {
            Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
            Accept: "application/json",
        },
    });

    if (!res.ok) {
        console.error(`SimpleFIN returned ${res.status} ${res.statusText}`);
        process.exit(1);
    }

    const body = await res.json();

    writeFileSync(outPath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    console.log(`Raw response written to ${outPath}`);
    console.log("");

    const accounts = body.accounts ?? [];
    const allHoldings = accounts.flatMap((a) => a.holdings ?? []);
    const allTxns = accounts.flatMap((a) => a.transactions ?? []);

    console.log("=== SCHEMA ===");
    console.log("top level:  ", Object.keys(body).sort().join(", "));
    console.log("account:    ", keysOf(accounts).join(", "));
    console.log("org:        ", keysOf(accounts.map((a) => a.org)).join(", "));
    console.log("holding:    ", keysOf(allHoldings).join(", ") || "(none)");
    console.log("transaction:", keysOf(allTxns).join(", ") || "(none)");
    console.log("");
    console.log(`errors:  ${JSON.stringify(body.errors ?? [])}`);
    console.log(`errlist: ${JSON.stringify(body.errlist ?? [])}`);

    if (quiet) return;

    for (const account of accounts) {
        console.log("");
        console.log("=".repeat(100));
        console.log(`${account.org?.name ?? "?"} · ${account.name}`);
        console.log(`  id:               ${account.id}`);
        console.log(`  currency:         ${account.currency}`);
        console.log(`  balance:          ${account.balance}`);
        console.log(`  available:        ${account["available-balance"] ?? "(none)"}`);
        console.log(`  balance-date:     ${fmtDate(account["balance-date"])}`);
        if (account.org) console.log(`  org:              ${JSON.stringify(account.org)}`);
        if (account.extra) console.log(`  extra:            ${JSON.stringify(account.extra)}`);

        const holdings = account.holdings ?? [];
        if (holdings.length) {
            console.log(`  HOLDINGS (${holdings.length}):`);
            table(
                holdings.map((h) => ({
                    ...h,
                    ...(h.created ? { created: fmtDate(h.created) } : {}),
                })),
            );
        }

        const txns = account.transactions ?? [];
        if (txns.length) {
            console.log(`  TRANSACTIONS (${txns.length}, last ${days}d):`);
            table(
                txns.map((t) => ({
                    ...t,
                    posted: fmtDate(t.posted),
                    ...(t.transacted_at ? { transacted_at: fmtDate(t.transacted_at) } : {}),
                })),
            );
        }
    }
})();
