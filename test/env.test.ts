import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, parseEnvFile } from "../src/env";

test("parseEnvFile handles the shapes people actually write", () => {
    const parsed = parseEnvFile(
        [
            "# a comment",
            "",
            "YNAB_API_TOKEN=abc123",
            "  export YNAB_BUDGET_ID = def456  ",
            `QUOTED="with spaces"`,
            "SINGLE='single quoted'",
            "TRAILING=value # not part of it",
            "EMPTY=",
            "not a pair",
            "1INVALID=nope",
        ].join("\n"),
    );

    assert.equal(parsed.YNAB_API_TOKEN, "abc123");
    assert.equal(parsed.YNAB_BUDGET_ID, "def456");
    assert.equal(parsed.QUOTED, "with spaces");
    assert.equal(parsed.SINGLE, "single quoted");
    assert.equal(parsed.TRAILING, "value");
    assert.equal(parsed.EMPTY, "");
    assert.equal(parsed["1INVALID"], undefined);
    assert.equal(Object.keys(parsed).length, 6);
});

test("a '#' inside an Access URL survives parsing", () => {
    // Basic Auth passwords routinely contain '#'; stripping it would silently break auth.
    const parsed = parseEnvFile(`SIMPLEFIN_ACCESS_URL=https://user:pa#ss@bridge.simplefin.org/simplefin`);
    assert.equal(parsed.SIMPLEFIN_ACCESS_URL, "https://user:pa#ss@bridge.simplefin.org/simplefin");

    const quoted = parseEnvFile(`SIMPLEFIN_ACCESS_URL="https://user:pa ss@x.org/y # z"`);
    assert.equal(quoted.SIMPLEFIN_ACCESS_URL, "https://user:pa ss@x.org/y # z");
});

test("loadEnv never overrides a real environment variable", () => {
    const dir = mkdtempSync(join(tmpdir(), "yss-env-"));
    const path = join(dir, ".env");
    writeFileSync(path, "YSS_TEST_PRESET=from-file\nYSS_TEST_FRESH=from-file\n");

    process.env.YSS_TEST_PRESET = "from-shell";
    delete process.env.YSS_TEST_FRESH;

    try {
        const loaded = loadEnv([path, join(dir, "absent.env")]);

        assert.deepEqual(loaded, [path], "missing files are skipped silently");
        assert.equal(process.env.YSS_TEST_PRESET, "from-shell");
        assert.equal(process.env.YSS_TEST_FRESH, "from-file");
    } finally {
        delete process.env.YSS_TEST_PRESET;
        delete process.env.YSS_TEST_FRESH;
    }
});

test("the first file wins when both define a key", () => {
    const dir = mkdtempSync(join(tmpdir(), "yss-env-"));
    const first = join(dir, "first.env");
    const second = join(dir, "second.env");
    writeFileSync(first, "YSS_TEST_ORDER=first\n");
    writeFileSync(second, "YSS_TEST_ORDER=second\n");

    delete process.env.YSS_TEST_ORDER;

    try {
        loadEnv([first, second]);
        assert.equal(process.env.YSS_TEST_ORDER, "first");
    } finally {
        delete process.env.YSS_TEST_ORDER;
    }
});
