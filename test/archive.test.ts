import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSnapshot, filterAccounts } from "../src/archive";
import type { SimpleFinAccountSet } from "../src/simplefin";

const dir = () => mkdtempSync(join(tmpdir(), "yss-archive-"));

const BD = 1_700_000_000; // 2023-11-14T22:13:20Z

const rawBody = {
    errors: [],
    accounts: [
        {
            id: "ACT-1",
            name: "Brokerage",
            currency: "USD",
            balance: "100.00",
            "balance-date": BD,
            // Non-standard Bridge extension — the whole reason we archive the raw body.
            holdings: [{ symbol: "VOO", shares: "1.5", market_value: "900.00" }],
            transactions: [
                { id: "TRN-1", amount: "-100.00", description: "buy 1 share", posted: BD },
                { id: "TRN-2", amount: "5.00", description: "dividend", posted: BD },
            ],
        },
        { id: "ACT-2", name: "Cash", currency: "USD", balance: "5.00", "balance-date": BD },
    ],
};

const accountSet = (raw: unknown): SimpleFinAccountSet => ({
    accounts: [],
    errlist: [],
    errors: [],
    raw,
});

/** Deep-clone and bump one account's balance-date, as a real SimpleFIN refresh would. */
const refreshed = (id: string, newBd: number) => {
    const body = structuredClone(rawBody) as typeof rawBody;
    const account = body.accounts.find((a) => a.id === id)!;
    account["balance-date"] = newBd;
    return body;
};

test("stores each account under <id>/<balance-date>.json, verbatim", () => {
    const target = dir();
    const result = writeSnapshot(target, accountSet(rawBody), new Date(), undefined);

    const path = join(target, "ACT-1", "2023-11-14T22-13-20Z.json");
    assert.ok(existsSync(path));

    const stored = JSON.parse(readFileSync(path, "utf8")) as { holdings?: { symbol: string }[] };
    assert.deepEqual(stored, rawBody.accounts[0]);
    // `holdings` is absent from our typed AccountSet; losing it would defeat the archive.
    assert.equal(stored.holdings?.[0]?.symbol, "VOO");

    assert.equal(result.written.length, 2);
    assert.equal(result.transactions, 2);
    assert.equal(result.holdings, 1);
    assert.deepEqual(result.unchanged, []);
});

test("skips an account whose balance-date has not advanced", () => {
    const target = dir();

    const first = writeSnapshot(target, accountSet(rawBody), new Date());
    assert.equal(first.written.length, 2);

    // Same data, same balance-dates — nothing should be rewritten.
    const second = writeSnapshot(target, accountSet(rawBody), new Date());
    assert.equal(second.written.length, 0);
    assert.deepEqual(second.unchanged.sort(), ["ACT-1", "ACT-2"]);
});

test("writes a new file only for the account SimpleFIN refreshed", () => {
    const target = dir();
    writeSnapshot(target, accountSet(rawBody), new Date());

    const newBd = BD + 7200; // two hours later
    const result = writeSnapshot(target, accountSet(refreshed("ACT-1", newBd)), new Date());

    assert.deepEqual(result.written.map((w) => w.id), ["ACT-1"]);
    assert.deepEqual(result.unchanged, ["ACT-2"]);

    // Both the old and the new point-in-time balances are retained for ACT-1.
    assert.deepEqual(
        readdirSync(join(target, "ACT-1")).sort(),
        ["2023-11-14T22-13-20Z.json", "2023-11-15T00-13-20Z.json"],
    );
    // ACT-2 still has exactly its one original snapshot.
    assert.deepEqual(readdirSync(join(target, "ACT-2")), ["2023-11-14T22-13-20Z.json"]);
});

test("snapshots are written owner-only", () => {
    const target = dir();
    const result = writeSnapshot(target, accountSet(rawBody), new Date());

    // Contains full transaction history, including card spend.
    assert.equal(statSync(result.written[0]!.path).mode & 0o077, 0);
});

test("creates nested account directories when absent", () => {
    const target = join(dir(), "nested", "deeper");
    const result = writeSnapshot(target, accountSet(rawBody), new Date());

    assert.ok(statSync(result.written[0]!.path).isFile());
});

test("falls back to the typed set when no raw body was captured", () => {
    const target = dir();
    const typed: SimpleFinAccountSet = { accounts: [], errlist: [], errors: ["capped"] };

    const result = writeSnapshot(target, typed, new Date());
    // No accounts to archive, and the top-level error does not derail the run.
    assert.equal(result.written.length, 0);
});

test("refuses a non-object snapshot rather than writing junk", () => {
    assert.throws(() => writeSnapshot(dir(), accountSet("not an object")), /not an object/);
});

test("an account with no balance-date is archived once under `undated`", () => {
    const target = dir();
    const undated = { errors: [], accounts: [{ id: "ACT-X", name: "Weird", balance: "1.00" }] };

    const first = writeSnapshot(target, accountSet(undated), new Date());
    assert.equal(first.written.length, 1);
    assert.ok(existsSync(join(target, "ACT-X", "undated.json")));

    const second = writeSnapshot(target, accountSet(undated), new Date());
    assert.equal(second.written.length, 0);
    assert.deepEqual(second.unchanged, ["ACT-X"]);
});

test("filters to the configured accounts and reports what it dropped", () => {
    const target = dir();
    const result = writeSnapshot(target, accountSet(rawBody), new Date(), ["ACT-1"]);

    assert.deepEqual(result.written.map((w) => w.id), ["ACT-1"]);
    assert.deepEqual(result.excluded, ["ACT-2"]);
    assert.deepEqual(result.missing, []);
    // Counts reflect what was actually stored, not what was fetched.
    assert.equal(result.transactions, 2);
    assert.equal(result.holdings, 1);
    assert.ok(!existsSync(join(target, "ACT-2")));
});

test("an undefined filter archives everything", () => {
    const target = dir();
    const result = writeSnapshot(target, accountSet(rawBody), new Date(), undefined);

    assert.equal(result.written.length, 2);
    assert.deepEqual(result.excluded, []);
});

test("reports configured ids the response did not contain", () => {
    // A stale id would otherwise silently archive nothing, and the 90-day window makes that
    // omission permanent.
    const { missing, excluded } = filterAccounts(rawBody, ["ACT-1", "ACT-GONE"]);

    assert.deepEqual(missing, ["ACT-GONE"]);
    assert.deepEqual(excluded, ["ACT-2"]);
});

test("filtering leaves other top-level fields intact", () => {
    const withErrors = { ...rawBody, errors: ["capped"], somethingElse: 42 };
    const { raw } = filterAccounts(withErrors, ["ACT-1"]);

    assert.deepEqual((raw as { errors: string[] }).errors, ["capped"]);
    assert.equal((raw as { somethingElse: number }).somethingElse, 42);
});

test("an empty filter list archives nothing rather than everything", () => {
    // Distinguishing [] from undefined matters: one is "exclude all", the other "include all".
    const { raw, excluded } = filterAccounts(rawBody, []);

    assert.deepEqual((raw as { accounts: unknown[] }).accounts, []);
    assert.equal(excluded.length, 2);
});
