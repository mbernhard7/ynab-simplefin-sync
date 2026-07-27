import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    formatEnvMap,
    parseEnvMap,
    readConfig,
    resolveBudgetId,
    resolveArchiveAccounts,
    resolveContributions,
    parseArchiveList,
    resolveMappings,
    shadowedByNote,
    writeConfig,
    type Config,
} from "../src/config";
import { parseSelection, suggestFor } from "../src/link";
import type { YnabAccountLike } from "../src/reconcile";
import type { SimpleFinAccount } from "../src/simplefin";

const ynab = (over: Partial<YnabAccountLike> & { id: string }): YnabAccountLike => ({
    name: "Account",
    balance: 0,
    ...over,
});

const config = (mappings: Config["mappings"]): Config => ({ version: 1, mappings });

test("parseEnvMap reads the CI mapping format", () => {
    assert.deepEqual(parseEnvMap("a=ACT-1"), { a: ["ACT-1"] });
    assert.deepEqual(parseEnvMap("a=ACT-1+ACT-2;b=ACT-3"), { a: ["ACT-1", "ACT-2"], b: ["ACT-3"] });
    assert.deepEqual(parseEnvMap(" a = ACT-1 ; b = ACT-2 "), { a: ["ACT-1"], b: ["ACT-2"] });
    assert.deepEqual(parseEnvMap(""), {});
    assert.deepEqual(parseEnvMap(undefined), {});
    assert.throws(() => parseEnvMap("a"), /missing '='/);
    assert.throws(() => parseEnvMap("a="), /incomplete/);
});

test("formatEnvMap round-trips through parseEnvMap", () => {
    const mappings = [
        { ynabAccountId: "a", simplefinIds: ["ACT-1", "ACT-2"], source: "config" as const },
        { ynabAccountId: "b", simplefinIds: ["ACT-3"], source: "config" as const },
    ];

    assert.deepEqual(parseEnvMap(formatEnvMap(mappings)), { a: ["ACT-1", "ACT-2"], b: ["ACT-3"] });
});

test("the YNAB note wins over config and env", () => {
    const accounts = [ynab({ id: "a", note: "SIMPLEFIN:ACT-note" })];

    const resolved = resolveMappings(accounts, {
        config: config({ a: { simplefinIds: ["ACT-config"] } }),
        env: "a=ACT-env",
    });

    assert.deepEqual(resolved, [{ ynabAccountId: "a", simplefinIds: ["ACT-note"], source: "note" }]);
});

test("config wins over env when there is no note", () => {
    const resolved = resolveMappings([ynab({ id: "a" })], {
        config: config({ a: { simplefinIds: ["ACT-config"] } }),
        env: "a=ACT-env",
    });

    assert.equal(resolved[0]?.source, "config");
});

test("env is used when nothing else maps the account", () => {
    const resolved = resolveMappings([ynab({ id: "a" })], { env: "a=ACT-env" });

    assert.deepEqual(resolved, [{ ynabAccountId: "a", simplefinIds: ["ACT-env"], source: "env" }]);
});

test("unmapped and deleted accounts are excluded", () => {
    const resolved = resolveMappings(
        [ynab({ id: "a" }), ynab({ id: "b", deleted: true, note: "SIMPLEFIN:ACT-1" })],
        {},
    );

    assert.deepEqual(resolved, []);
});

test("shadowedByNote flags saved mappings a note would override", () => {
    const accounts = [ynab({ id: "a", note: "SIMPLEFIN:ACT-note" }), ynab({ id: "b" })];
    const shadowed = shadowedByNote(
        accounts,
        config({ a: { simplefinIds: ["ACT-1"] }, b: { simplefinIds: ["ACT-2"] } }),
    );

    assert.deepEqual(shadowed.map((a) => a.id), ["a"]);
});

test("config round-trips to disk and is written owner-only", () => {
    const path = join(mkdtempSync(join(tmpdir(), "yss-")), "mappings.json");
    const written = config({ a: { name: "Roth IRA", simplefinIds: ["ACT-1", "ACT-2"] } });

    writeConfig(written, path);

    assert.deepEqual(readConfig(path), written);
    // The file names the user's accounts; keep it off other users' radar.
    assert.equal(statSync(path).mode & 0o077, 0);
});

test("budgetId round-trips and the environment overrides it", () => {
    const path = join(mkdtempSync(join(tmpdir(), "yss-")), "config.json");
    writeConfig({ version: 1, budgetId: "budget-from-config", mappings: {} }, path);

    const loaded = readConfig(path);
    assert.equal(loaded.budgetId, "budget-from-config");

    delete process.env.YNAB_BUDGET_ID;
    assert.equal(resolveBudgetId(loaded), "budget-from-config");

    try {
        process.env.YNAB_BUDGET_ID = "budget-from-env";
        assert.equal(resolveBudgetId(loaded), "budget-from-env");
    } finally {
        delete process.env.YNAB_BUDGET_ID;
    }

    assert.equal(resolveBudgetId({ version: 1, mappings: {} }), undefined);
});

test("secrets never reach the config file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "yss-")), "config.json");
    writeConfig({ version: 1, budgetId: "b", mappings: { a: { simplefinIds: ["ACT-1"] } } }, path);

    assert.doesNotMatch(readFileSync(path, "utf8"), /TOKEN|ACCESS_URL|password|bridge\.simplefin/i);
});

test("a missing config file reads as empty, malformed entries are dropped", () => {
    const dir = mkdtempSync(join(tmpdir(), "yss-"));

    // An explicit path must never fall through to the real config in the user's home
    // directory — the legacy-filename fallback applies only to the default location.
    assert.deepEqual(readConfig(join(dir, "absent.json")), { version: 1, mappings: {} });

    const junk = join(dir, "junk.json");
    writeFileSync(junk, JSON.stringify({ mappings: { a: { simplefinIds: "nope" }, b: null, c: { simplefinIds: ["ACT-1"] } } }));
    assert.deepEqual(readConfig(junk).mappings, { c: { simplefinIds: ["ACT-1"] } });

    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{not json");
    assert.throws(() => readConfig(broken), /not valid JSON/);
});

test("parseSelection understands lists, all, none, and rejects bad input", () => {
    assert.deepEqual(parseSelection("1,3", 5), [0, 2]);
    assert.deepEqual(parseSelection("2 4", 5), [1, 3]);
    assert.deepEqual(parseSelection("all", 3), [0, 1, 2]);
    assert.deepEqual(parseSelection("", 3), []);
    assert.deepEqual(parseSelection("none", 3), []);
    assert.deepEqual(parseSelection("2,2", 3), [1], "duplicates collapse");
    assert.equal(parseSelection("0", 3), null);
    assert.equal(parseSelection("4", 3), null);
    assert.equal(parseSelection("abc", 3), null);
});

test("suggestFor matches on shared name tokens and abstains when unsure", () => {
    const candidates: SimpleFinAccount[] = [
        { id: "ACT-1", name: "Individual", currency: "USD", balance: "1", "balance-date": 0, org: { name: "Robinhood" } },
        { id: "ACT-2", name: "Roth IRA", currency: "USD", balance: "1", "balance-date": 0, org: { name: "Robinhood" } },
    ];

    assert.equal(suggestFor(ynab({ id: "a", name: "Robinhood Roth IRA" }), candidates), 1);
    assert.equal(suggestFor(ynab({ id: "a", name: "Checking" }), candidates), -1);
    assert.equal(suggestFor(ynab({ id: "a", name: "" }), candidates), -1);
});

test("parseArchiveList: empty is none, 'all' is everything, otherwise the listed ids", () => {
    assert.deepEqual(parseArchiveList(undefined), []);
    assert.deepEqual(parseArchiveList(""), []);
    assert.equal(parseArchiveList("all"), undefined);
    assert.equal(parseArchiveList("ALL"), undefined);
    assert.deepEqual(parseArchiveList("ACT-1;ACT-2"), ["ACT-1", "ACT-2"]);
    assert.deepEqual(parseArchiveList("ACT-1, ACT-2"), ["ACT-1", "ACT-2"]);
    assert.deepEqual(parseArchiveList(" ACT-1 "), ["ACT-1"]);
});

test("archiveAccounts defaults to none, round-trips, and the environment overrides it", () => {
    const path = join(mkdtempSync(join(tmpdir(), "yss-")), "config.json");
    writeConfig({ version: 1, mappings: {}, archiveAccounts: ["ACT-cfg"] }, path);

    const loaded = readConfig(path);
    assert.deepEqual(loaded.archiveAccounts, ["ACT-cfg"]);

    delete process.env.SIMPLEFIN_ARCHIVE_ACCOUNTS;
    assert.deepEqual(resolveArchiveAccounts(loaded), ["ACT-cfg"]);

    try {
        process.env.SIMPLEFIN_ARCHIVE_ACCOUNTS = "ACT-env";
        assert.deepEqual(resolveArchiveAccounts(loaded), ["ACT-env"]);

        // "all" in the environment means archive everything.
        process.env.SIMPLEFIN_ARCHIVE_ACCOUNTS = "all";
        assert.equal(resolveArchiveAccounts(loaded), undefined);
    } finally {
        delete process.env.SIMPLEFIN_ARCHIVE_ACCOUNTS;
    }

    // Nothing configured means nothing is archived.
    assert.deepEqual(resolveArchiveAccounts({ version: 1, mappings: {} }), []);
});

test("contribution rules are read from the config file", () => {
    const path = join(tmpdir(), `yss-contrib-${process.pid}-${Math.random()}.json`);
    writeFileSync(
        path,
        JSON.stringify({
            version: 1,
            mappings: {},
            contributions: {
                since: "2026-07-23",
                rules: [
                    {
                        simplefinId: "ACT-401k",
                        match: "^contribution$",
                        sign: "negative",
                        payee: "401(k) Contribution",
                        reviewWindow: { from: "01-10", to: "02-15" },
                    },
                ],
            },
        }),
    );

    try {
        const config = readConfig(path);
        assert.equal(config.contributions?.since, "2026-07-23");
        assert.equal(config.contributions?.rules.length, 1);
        assert.equal(config.contributions?.rules[0]!.sign, "negative");
        assert.deepEqual(config.contributions?.rules[0]!.reviewWindow, { from: "01-10", to: "02-15" });
    } finally {
        rmSync(path, { force: true });
    }
});

test("a malformed contribution rule is rejected, not quietly dropped", () => {
    const write = (contributions: unknown): string => {
        const path = join(tmpdir(), `yss-bad-${process.pid}-${Math.random()}.json`);
        writeFileSync(path, JSON.stringify({ version: 1, mappings: {}, contributions }));
        return path;
    };

    // A rule without a sign would post withdrawals as income.
    const noSign = write({ rules: [{ simplefinId: "A", match: "x", payee: "P" }] });
    assert.throws(() => readConfig(noSign), /"sign" to be "positive" or "negative"/);
    rmSync(noSign, { force: true });

    const noPayee = write({ rules: [{ simplefinId: "A", match: "x", sign: "positive" }] });
    assert.throws(() => readConfig(noPayee), /missing a non-empty "payee"/);
    rmSync(noPayee, { force: true });

    const badSince = write({ since: "July", rules: [{ simplefinId: "A", match: "x", sign: "positive", payee: "P" }] });
    assert.throws(() => readConfig(badSince), /must be a YYYY-MM-DD date/);
    rmSync(badSince, { force: true });
});

test("SIMPLEFIN_CONTRIBUTIONS overrides the config file, as the scheduled job needs", () => {
    const path = join(tmpdir(), `yss-env-${process.pid}-${Math.random()}.json`);
    writeFileSync(
        path,
        JSON.stringify({
            version: 1,
            mappings: {},
            contributions: { rules: [{ simplefinId: "FROM-FILE", match: "x", sign: "positive", payee: "File" }] },
        }),
    );

    const previous = process.env.SIMPLEFIN_CONTRIBUTIONS;
    try {
        const config = readConfig(path);

        process.env.SIMPLEFIN_CONTRIBUTIONS = JSON.stringify({
            since: "2026-07-23",
            rules: [{ simplefinId: "FROM-ENV", match: "y", sign: "negative", payee: "Env" }],
        });
        assert.equal(resolveContributions(config)?.rules[0]!.simplefinId, "FROM-ENV");

        process.env.SIMPLEFIN_CONTRIBUTIONS = "";
        assert.equal(resolveContributions(config)?.rules[0]!.simplefinId, "FROM-FILE");

        process.env.SIMPLEFIN_CONTRIBUTIONS = "{not json";
        assert.throws(() => resolveContributions(config), /not valid JSON/);
    } finally {
        if (previous === undefined) delete process.env.SIMPLEFIN_CONTRIBUTIONS;
        else process.env.SIMPLEFIN_CONTRIBUTIONS = previous;
        rmSync(path, { force: true });
    }
});
