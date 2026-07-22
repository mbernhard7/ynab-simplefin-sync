import test from "node:test";
import assert from "node:assert/strict";
import { buildImportId, parseNote, reconcile, type YnabAccountLike } from "../src/reconcile";
import { toMilliunits } from "../src/money";
import type { SimpleFinAccount, SimpleFinAccountSet } from "../src/simplefin";

const NOW = new Date("2026-07-22T18:00:00Z");
const FRESH = Math.floor(NOW.getTime() / 1000) - 60 * 60 * 2;

const sfAccount = (over: Partial<SimpleFinAccount> & { id: string }): SimpleFinAccount => ({
    name: "Brokerage",
    currency: "USD",
    balance: "1000.00",
    "balance-date": FRESH,
    org: { name: "Robinhood" },
    conn_id: "CON-1",
    ...over,
});

const set = (accounts: SimpleFinAccount[], over: Partial<SimpleFinAccountSet> = {}): SimpleFinAccountSet => ({
    accounts,
    errlist: [],
    errors: [],
    ...over,
});

const ynab = (over: Partial<YnabAccountLike> = {}): YnabAccountLike => ({
    id: "11111111-2222-3333-4444-555555555555",
    name: "Robinhood Brokerage",
    note: "SIMPLEFIN:ACT-1",
    balance: 900_000,
    ...over,
});

test("toMilliunits converts decimal strings without float drift", () => {
    assert.equal(toMilliunits("1000.00"), 1_000_000);
    assert.equal(toMilliunits("-0.7"), -700);
    assert.equal(toMilliunits("142344.93"), 142_344_930);
    assert.equal(toMilliunits(".5"), 500);
    assert.equal(toMilliunits("0"), 0);
    // Rounds on the 4th decimal rather than truncating.
    assert.equal(toMilliunits("1.2345"), 1235);
    assert.equal(toMilliunits("1.2344"), 1234);
    assert.throws(() => toMilliunits("1,000.00"));
    assert.throws(() => toMilliunits("abc"));
    assert.throws(() => toMilliunits(""));
});

test("parseNote extracts ids and tolerates surrounding prose", () => {
    assert.deepEqual(parseNote("SIMPLEFIN:ACT-1"), ["ACT-1"]);
    assert.deepEqual(parseNote("my roth ira\nSIMPLEFIN:ACT-abc123\nopened 2019"), ["ACT-abc123"]);
    assert.deepEqual(parseNote("SIMPLEFIN:ACT-cash+ACT-invest"), ["ACT-cash", "ACT-invest"]);
    assert.deepEqual(parseNote("INVESTMENT_ACCOUNT"), []);
    assert.deepEqual(parseNote(null), []);
    assert.deepEqual(parseNote(undefined), []);
});

test("import ids stay within YNAB's 36-character limit and are stable", () => {
    const id = buildImportId("11111111-2222-3333-4444-555555555555", "2026-07-22");
    assert.ok(id.length <= 36, `import_id too long: ${id.length}`);
    assert.equal(id, buildImportId("11111111-2222-3333-4444-555555555555", "2026-07-22"));
    assert.notEqual(id, buildImportId("99999999-2222-3333-4444-555555555555", "2026-07-22"));
});

test("computes the delta between YNAB and SimpleFIN", () => {
    const [plan] = reconcile([ynab()], set([sfAccount({ id: "ACT-1" })]), { now: NOW });

    assert.equal(plan?.action, "adjust");
    assert.equal(plan?.targetMilliunits, 1_000_000);
    assert.equal(plan?.deltaMilliunits, 100_000);
    assert.equal(plan?.stale, false);
    assert.match(plan?.memo ?? "", /^Robinhood · as of /);
});

test("sums multiple SimpleFIN accounts mapped to one YNAB account", () => {
    const [plan] = reconcile(
        [ynab({ note: "SIMPLEFIN:ACT-cash+ACT-invest", balance: 0 })],
        set([
            sfAccount({ id: "ACT-cash", balance: "1200.50", org: { name: "HSA Bank" } }),
            sfAccount({ id: "ACT-invest", balance: "8800.25", org: { name: "HSA Bank" } }),
        ]),
        { now: NOW, thresholdAbsolute: 100_000_000 },
    );

    assert.equal(plan?.action, "adjust");
    assert.equal(plan?.targetMilliunits, 10_000_750);
    assert.equal(plan?.memo?.includes("HSA Bank"), true);
});

test("emits noop when the balances already agree", () => {
    const [plan] = reconcile([ynab({ balance: 1_000_000 })], set([sfAccount({ id: "ACT-1" })]), { now: NOW });

    assert.equal(plan?.action, "noop");
    assert.equal(plan?.deltaMilliunits, 0);
});

test("ignores YNAB accounts without the mapping key", () => {
    const plans = reconcile(
        [ynab({ note: "INVESTMENT_ACCOUNT" }), ynab({ id: "other", note: null })],
        set([sfAccount({ id: "ACT-1" })]),
        { now: NOW },
    );

    assert.equal(plans.length, 0);
});

test("never treats a missing SimpleFIN account as a zero balance", () => {
    const [plan] = reconcile([ynab()], set([sfAccount({ id: "ACT-SOMETHING-ELSE" })]), { now: NOW });

    assert.equal(plan?.action, "skip");
    assert.equal(plan?.reason, "account-missing");
    assert.equal(plan?.targetMilliunits, undefined);
});

test("skips an account whose connection reported an error", () => {
    const [plan] = reconcile(
        [ynab()],
        set([sfAccount({ id: "ACT-1" })], {
            errlist: [{ code: "con-auth", msg: "Fidelity needs re-authentication", conn_id: "CON-1" }],
        }),
        { now: NOW },
    );

    assert.equal(plan?.action, "skip");
    assert.equal(plan?.reason, "connection-error");
    assert.match(plan?.detail ?? "", /re-authentication/);
});

test("skips an account-scoped error even when the connection is healthy", () => {
    const [plan] = reconcile(
        [ynab()],
        set([sfAccount({ id: "ACT-1" })], {
            errlist: [{ code: "act-stale", msg: "stale", account_id: "ACT-1" }],
        }),
        { now: NOW },
    );

    assert.equal(plan?.reason, "connection-error");
});

test("blocks an implausibly large adjustment unless forced", () => {
    const accounts = set([sfAccount({ id: "ACT-1", balance: "0.00" })]);
    const account = ynab({ balance: 180_000_000 });

    const [blocked] = reconcile([account], accounts, { now: NOW });
    assert.equal(blocked?.action, "skip");
    assert.equal(blocked?.reason, "exceeds-threshold");
    assert.equal(blocked?.deltaMilliunits, -180_000_000);

    const [forced] = reconcile([account], accounts, { now: NOW, force: true });
    assert.equal(forced?.action, "adjust");
});

test("allows a large adjustment that is small relative to the account", () => {
    const [plan] = reconcile(
        [ynab({ balance: 180_000_000 })],
        set([sfAccount({ id: "ACT-1", balance: "210000.00" })]),
        { now: NOW },
    );

    // $30k exceeds the $25k floor but sits under 40% of a $180k account.
    assert.equal(plan?.action, "adjust");
    assert.equal(plan?.deltaMilliunits, 30_000_000);
});

test("flags stale balances but still reconciles them", () => {
    const [plan] = reconcile(
        [ynab()],
        set([sfAccount({ id: "ACT-1", "balance-date": Math.floor(NOW.getTime() / 1000) - 60 * 60 * 72 })]),
        { now: NOW },
    );

    assert.equal(plan?.action, "adjust");
    assert.equal(plan?.stale, true);
    assert.match(plan?.memo ?? "", /^STALE /);
});

test("uses the oldest balance-date when several accounts are summed", () => {
    const old = Math.floor(NOW.getTime() / 1000) - 60 * 60 * 72;
    const [plan] = reconcile(
        [ynab({ note: "SIMPLEFIN:ACT-a+ACT-b", balance: 0 })],
        set([
            sfAccount({ id: "ACT-a", balance: "10.00" }),
            sfAccount({ id: "ACT-b", balance: "10.00", "balance-date": old }),
        ]),
        { now: NOW },
    );

    assert.equal(plan?.stale, true);
    assert.equal(plan?.balanceDate?.getTime(), old * 1000);
});

test("skips closed, non-USD, and unparseable accounts", () => {
    const [closed] = reconcile([ynab({ closed: true })], set([sfAccount({ id: "ACT-1" })]), { now: NOW });
    assert.equal(closed?.reason, "account-closed");

    const [foreign] = reconcile([ynab()], set([sfAccount({ id: "ACT-1", currency: "CAD" })]), { now: NOW });
    assert.equal(foreign?.reason, "non-usd");

    const [garbage] = reconcile([ynab()], set([sfAccount({ id: "ACT-1", balance: "n/a" })]), { now: NOW });
    assert.equal(garbage?.reason, "unparseable-balance");

    const deleted = reconcile([ynab({ deleted: true })], set([sfAccount({ id: "ACT-1" })]), { now: NOW });
    assert.equal(deleted.length, 0);
});
