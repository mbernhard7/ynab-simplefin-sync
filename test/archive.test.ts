import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSnapshot } from "../src/archive";
import type { SimpleFinAccountSet } from "../src/simplefin";

const dir = () => mkdtempSync(join(tmpdir(), "yss-archive-"));

const rawBody = {
    errors: [],
    accounts: [
        {
            id: "ACT-1",
            name: "Brokerage",
            currency: "USD",
            balance: "100.00",
            "balance-date": 1_700_000_000,
            // Non-standard Bridge extension — the whole reason we archive the raw body.
            holdings: [{ symbol: "VOO", shares: "1.5", market_value: "900.00" }],
            transactions: [
                { id: "TRN-1", amount: "-100.00", description: "buy 1 share", posted: 1_700_000_000 },
                { id: "TRN-2", amount: "5.00", description: "dividend", posted: 1_700_000_000 },
            ],
        },
        { id: "ACT-2", name: "Cash", currency: "USD", balance: "5.00", "balance-date": 1_700_000_000 },
    ],
};

const accountSet = (raw: unknown): SimpleFinAccountSet => ({
    accounts: [],
    errlist: [],
    errors: [],
    raw,
});

test("archives the raw body verbatim, preserving fields the parser drops", () => {
    const target = dir();
    const result = writeSnapshot(target, accountSet(rawBody), new Date("2026-07-22T12:00:00Z"));

    const written = JSON.parse(readFileSync(result.path, "utf8"));

    assert.deepEqual(written, rawBody);
    // `holdings` is absent from our typed AccountSet; losing it would defeat the archive.
    assert.equal(written.accounts?.[0]?.holdings?.[0]?.symbol, "VOO");
});

test("names snapshots by local date and reports what it stored", () => {
    const target = dir();
    const result = writeSnapshot(target, accountSet(rawBody), new Date("2026-07-22T12:00:00Z"));

    assert.match(result.path, /simplefin-2026-07-22\.json$/);
    assert.equal(result.accounts, 2);
    assert.equal(result.transactions, 2);
    assert.equal(result.holdings, 1);
    assert.ok(result.bytes > 0);
});

test("re-running the same day overwrites rather than accumulating", () => {
    const target = dir();
    const when = new Date("2026-07-22T12:00:00Z");

    writeSnapshot(target, accountSet(rawBody), when);
    writeSnapshot(target, accountSet({ ...rawBody, accounts: [] }), when);

    assert.deepEqual(readdirSync(target), ["simplefin-2026-07-22.json"]);
    assert.deepEqual(JSON.parse(readFileSync(join(target, "simplefin-2026-07-22.json"), "utf8")).accounts, []);
});

test("snapshots are written owner-only", () => {
    const target = dir();
    const result = writeSnapshot(target, accountSet(rawBody), new Date("2026-07-22T12:00:00Z"));

    // Contains full transaction history, including card spend.
    assert.equal(statSync(result.path).mode & 0o077, 0);
});

test("creates the target directory when absent", () => {
    const target = join(dir(), "nested", "deeper");
    const result = writeSnapshot(target, accountSet(rawBody), new Date("2026-07-22T12:00:00Z"));

    assert.ok(statSync(result.path).isFile());
});

test("falls back to the typed set when no raw body was captured", () => {
    const target = dir();
    const typed: SimpleFinAccountSet = { accounts: [], errlist: [], errors: ["capped"] };

    const result = writeSnapshot(target, typed, new Date("2026-07-22T12:00:00Z"));

    assert.deepEqual(JSON.parse(readFileSync(result.path, "utf8")).errors, ["capped"]);
});

test("refuses a non-object snapshot rather than writing junk", () => {
    assert.throws(() => writeSnapshot(dir(), accountSet("not an object")), /not an object/);
});
