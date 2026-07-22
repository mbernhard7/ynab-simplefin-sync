import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertEnvFile } from "../src/setup";
import { parseEnvFile } from "../src/env";

const tempFile = (name = ".env") => join(mkdtempSync(join(tmpdir(), "yss-setup-")), name);

test("upsertEnvFile creates the file owner-only", () => {
    const path = tempFile();

    upsertEnvFile(path, { YNAB_API_TOKEN: "abc", SIMPLEFIN_ACCESS_URL: "https://u:p@x.org/y" });

    const parsed = parseEnvFile(readFileSync(path, "utf8"));
    assert.equal(parsed.YNAB_API_TOKEN, "abc");
    assert.equal(parsed.SIMPLEFIN_ACCESS_URL, "https://u:p@x.org/y");
    // The file holds a bank credential.
    assert.equal(statSync(path).mode & 0o077, 0);
});

test("re-running setup replaces values instead of duplicating them", () => {
    const path = tempFile();

    upsertEnvFile(path, { YNAB_API_TOKEN: "first" });
    upsertEnvFile(path, { YNAB_API_TOKEN: "second" });

    const contents = readFileSync(path, "utf8");
    assert.equal(contents.match(/YNAB_API_TOKEN=/g)?.length, 1, "key written more than once");
    assert.equal(parseEnvFile(contents).YNAB_API_TOKEN, "second");
});

test("unrelated lines and comments are preserved", () => {
    const path = tempFile();
    writeFileSync(path, "# my notes\nOTHER_VAR=keep-me\nYNAB_API_TOKEN=old\n");

    upsertEnvFile(path, { YNAB_API_TOKEN: "new", SIMPLEFIN_ACCESS_URL: "https://u:p@x.org/y" });

    const contents = readFileSync(path, "utf8");
    assert.match(contents, /# my notes/);

    const parsed = parseEnvFile(contents);
    assert.equal(parsed.OTHER_VAR, "keep-me");
    assert.equal(parsed.YNAB_API_TOKEN, "new");
    assert.equal(parsed.SIMPLEFIN_ACCESS_URL, "https://u:p@x.org/y");
});

test("an `export`-prefixed line is updated rather than duplicated", () => {
    const path = tempFile();
    writeFileSync(path, "export YNAB_API_TOKEN=old\n");

    upsertEnvFile(path, { YNAB_API_TOKEN: "new" });

    const contents = readFileSync(path, "utf8");
    assert.equal(contents.match(/YNAB_API_TOKEN=/g)?.length, 1);
    assert.equal(parseEnvFile(contents).YNAB_API_TOKEN, "new");
});
