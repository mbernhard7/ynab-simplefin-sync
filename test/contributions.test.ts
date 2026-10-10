import test from "node:test";
import assert from "node:assert/strict";
import {
    buildContributionImportId,
    contributionTotals,
    inMonthDayWindow,
    planContributions,
    splitAlreadyPosted,
    type ContributionPlan,
    type ContributionsConfig,
} from "../src/contributions";
import type { SimpleFinAccount, SimpleFinAccountSet, SimpleFinTransaction } from "../src/simplefin";

const YNAB_401K = "65e4820c-1d5f-40aa-a579-702ff17280cb";
const YNAB_HSA = "f3b8e4ff-e1ca-4c2e-b76d-40ca822050ad";
const SF_401K = "ACT-401k";
const SF_HSA = "ACT-hsa";

const MAPPINGS = [
    { ynabAccountId: YNAB_401K, simplefinIds: [SF_401K] },
    { ynabAccountId: YNAB_HSA, simplefinIds: [SF_HSA] },
];

/** Noon UTC, so the calendar date is the same whether the runner is UTC or US-Eastern. */
const at = (date: string): number => Math.floor(new Date(`${date}T12:00:00Z`).getTime() / 1000);

const txn = (over: Partial<SimpleFinTransaction> & { id: string; posted: number; amount: string }): SimpleFinTransaction => ({
    memo: "",
    ...over,
});

const account = (id: string, name: string, transactions: SimpleFinTransaction[]): SimpleFinAccount => ({
    id,
    name,
    currency: "USD",
    balance: "1000.00",
    "balance-date": at("2026-07-25"),
    org: { name: id === SF_401K ? "Fidelity Investments" : "HSA Bank - Webster" },
    transactions,
});

const set = (accounts: SimpleFinAccount[]): SimpleFinAccountSet => ({ accounts, errlist: [], errors: [] });

/** Fidelity splits one pay period across five funds and books every leg negative. */
const payPeriod = (date: string, prefix: string): SimpleFinTransaction[] =>
    ["-510.68", "-204.27", "-204.27", "-20.42", "-81.71"].map((amount, i) =>
        txn({ id: `${prefix}-${i}`, posted: at(date), amount, description: "contribution", payee: "Contribution" }),
    );

const RULES: ContributionsConfig = {
    rules: [
        {
            simplefinId: SF_401K,
            match: "^contribution$",
            sign: "negative",
            payee: "401(k) Contribution",
            reviewWindow: { from: "01-10", to: "02-15" },
        },
        {
            simplefinId: SF_HSA,
            match: "^employee payroll$",
            sign: "positive",
            payee: "HSA Payroll Contribution",
        },
    ],
};

test("the five per-fund legs of one pay period become a single positive contribution", () => {
    const plans = planContributions(set([account(SF_401K, "RNBW 401(K)", payPeriod("2026-07-16", "a"))]), {
        contributions: RULES,
        mappings: MAPPINGS,
    });

    assert.equal(plans.length, 1);
    assert.equal(plans[0]!.date, "2026-07-16");
    assert.equal(plans[0]!.ynabAccountId, YNAB_401K);
    assert.equal(plans[0]!.payee, "401(k) Contribution");
    // -510.68 + -204.27 + -204.27 + -20.42 + -81.71, sign-flipped into an inflow.
    assert.equal(plans[0]!.amountMilliunits, 1_021_350);
    assert.equal(plans[0]!.sourceIds.length, 5);
});

test("separate pay periods stay separate transactions", () => {
    const plans = planContributions(
        set([account(SF_401K, "RNBW 401(K)", [...payPeriod("2026-07-01", "a"), ...payPeriod("2026-07-16", "b")])]),
        { contributions: RULES, mappings: MAPPINGS },
    );

    assert.deepEqual(
        plans.map((p) => [p.date, p.amountMilliunits]),
        [
            ["2026-07-01", 1_021_350],
            ["2026-07-16", 1_021_350],
        ],
    );
});

test("the sign filter keeps a withdrawal from posting as income", () => {
    // Same description, opposite sign: a distribution out of the plan, not a contribution.
    const plans = planContributions(
        set([
            account(SF_401K, "RNBW 401(K)", [
                txn({ id: "out", posted: at("2026-07-16"), amount: "5000.00", description: "contribution" }),
            ]),
        ]),
        { contributions: RULES, mappings: MAPPINGS },
    );

    assert.deepEqual(plans, []);
});

test("dividends and internal sweeps are not contributions", () => {
    const plans = planContributions(
        set([
            account(SF_401K, "RNBW 401(K)", [
                txn({ id: "d", posted: at("2026-07-10"), amount: "115.15", description: "dividend" }),
            ]),
            account(SF_HSA, "HSA", [
                txn({ id: "i", posted: at("2026-07-22"), amount: "-166.67", description: "Investment", memo: "Investment" }),
                txn({ id: "n", posted: at("2026-06-30"), amount: "0.04", description: "Interest", memo: "Interest" }),
                txn({ id: "p", posted: at("2026-07-21"), amount: "166.67", description: "Employee Payroll", memo: "Employee Payroll" }),
            ]),
        ]),
        { contributions: RULES, mappings: MAPPINGS },
    );

    assert.equal(plans.length, 1);
    assert.equal(plans[0]!.payee, "HSA Payroll Contribution");
    assert.equal(plans[0]!.amountMilliunits, 166_670);
});

test("`since` draws the cutover line for historical contributions", () => {
    const accounts = set([
        account(SF_401K, "RNBW 401(K)", [...payPeriod("2026-07-01", "a"), ...payPeriod("2026-07-16", "b")]),
    ]);

    const plans = planContributions(accounts, {
        contributions: { ...RULES, since: "2026-07-10" },
        mappings: MAPPINGS,
    });

    assert.deepEqual(plans.map((p) => p.date), ["2026-07-16"]);
});

test("a rule for an unmapped SimpleFIN account plans nothing", () => {
    const plans = planContributions(set([account(SF_401K, "RNBW 401(K)", payPeriod("2026-07-16", "a"))]), {
        contributions: RULES,
        mappings: [{ ynabAccountId: YNAB_HSA, simplefinIds: [SF_HSA] }],
    });

    assert.deepEqual(plans, []);
});

test("balances-only responses carry no transactions and plan nothing", () => {
    const bare: SimpleFinAccount = { ...account(SF_401K, "RNBW 401(K)", []), transactions: undefined };
    assert.deepEqual(planContributions(set([bare]), { contributions: RULES, mappings: MAPPINGS }), []);
});

test("a late-January deposit is posted but flagged, never silently labelled", () => {
    const plans = planContributions(
        set([
            account(SF_401K, "RNBW 401(K)", [
                ...payPeriod("2026-07-16", "regular"),
                txn({ id: "match", posted: at("2026-01-29"), amount: "-4567.50", description: "contribution" }),
            ]),
        ]),
        { contributions: RULES, mappings: MAPPINGS },
    );

    const january = plans.find((p) => p.date === "2026-01-29")!;
    assert.equal(january.needsReview, true);
    assert.equal(january.amountMilliunits, 4_567_500);
    assert.match(january.memo, /REVIEW/);

    // The money still posts — a flag is a note for a human, not a reason to drop income.
    assert.equal(plans.find((p) => p.date === "2026-07-16")!.needsReview, false);
});

test("review windows may wrap the year end", () => {
    assert.equal(inMonthDayWindow("2026-01-29", "01-10", "02-15"), true);
    assert.equal(inMonthDayWindow("2026-07-16", "01-10", "02-15"), false);
    assert.equal(inMonthDayWindow("2026-01-05", "12-15", "01-15"), true);
    assert.equal(inMonthDayWindow("2026-12-20", "12-15", "01-15"), true);
    assert.equal(inMonthDayWindow("2026-06-01", "12-15", "01-15"), false);
});

test("import ids fit YNAB's limit and are stable", () => {
    const id = buildContributionImportId(YNAB_401K, "2026-01-29", "401(k) Employer Match");

    assert.ok(id.length <= 36, `import_id too long: ${id.length}`);
    assert.equal(id, buildContributionImportId(YNAB_401K, "2026-01-29", "401(k) Employer Match"));

    // Different payees on one day stay distinct, so a match and a deferral can share a date.
    assert.notEqual(id, buildContributionImportId(YNAB_401K, "2026-01-29", "401(k) Contribution"));
});

test("a plan's import id is stable for a given account, date and payee", () => {
    const plans = planContributions(set([account(SF_401K, "RNBW 401(K)", payPeriod("2026-07-16", "a"))]), {
        contributions: RULES,
        mappings: MAPPINGS,
    });

    assert.equal(plans[0]!.importId, buildContributionImportId(YNAB_401K, "2026-07-16", "401(k) Contribution"));
});

test("contributionTotals sums per YNAB account for the pre-adjustment balance", () => {
    const plans = planContributions(
        set([
            account(SF_401K, "RNBW 401(K)", [...payPeriod("2026-07-01", "a"), ...payPeriod("2026-07-16", "b")]),
            account(SF_HSA, "HSA", [
                txn({ id: "p", posted: at("2026-07-21"), amount: "166.67", description: "Employee Payroll" }),
            ]),
        ]),
        { contributions: RULES, mappings: MAPPINGS },
    );

    const totals = contributionTotals(plans);
    assert.equal(totals.get(YNAB_401K), 2_042_700);
    assert.equal(totals.get(YNAB_HSA), 166_670);
});

test("an invalid rule pattern fails loudly rather than matching nothing", () => {
    assert.throws(
        () =>
            planContributions(set([account(SF_401K, "RNBW 401(K)", payPeriod("2026-07-16", "a"))]), {
                contributions: { rules: [{ simplefinId: SF_401K, match: "([", sign: "negative", payee: "X" }] },
                mappings: MAPPINGS,
            }),
        /invalid match/,
    );
});

test("splitAlreadyPosted keeps a contribution YNAB already holds out of the pending set", () => {
    const plan = (importId: string) => ({ importId, amountMilliunits: 100_000 }) as unknown as ContributionPlan;
    const { pending, present } = splitAlreadyPosted([plan("YSS:C:a"), plan("YSS:C:b"), plan("YSS:C:c")], new Set(["YSS:C:b"]));

    assert.deepEqual(pending.map((p) => p.importId), ["YSS:C:a", "YSS:C:c"]);
    assert.deepEqual(present.map((p) => p.importId), ["YSS:C:b"]);
});
