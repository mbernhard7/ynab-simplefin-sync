# ynab-simplefin-sync

Keeps YNAB investment account balances in sync with reality by asking
[SimpleFIN Bridge](https://beta-bridge.simplefin.org/) what each account is actually worth and
posting a single adjustment for the difference.

Successor to [`ynab_investment_tracking`](https://github.com/mbernhard7/ynab-investment-tracker),
which reconstructed holdings from hand-written `$TICKER|BUY 12.5` memos and priced them through
Yahoo Finance. This one doesn't model positions at all — no memos, no tickers, no quotes.

## How it works

1. Reads every YNAB account whose **note** contains a `SIMPLEFIN:<account-id>` key.
2. Fetches all balances from SimpleFIN in one request.
3. For each mapped account, computes `simplefinBalance − ynabBalance`.
4. Posts (or amends) **one** `Balance Adjustment` transaction per account per day.

## Mapping accounts

The fastest way is the interactive picker:

```bash
ynab-simplefin-sync link
```

It lists your YNAB accounts, lets you pick which to map, then for each one shows the SimpleFIN
accounts (with a suggested match based on the name) and lets you choose. Comma-separate to sum
several SimpleFIN accounts into one YNAB account — HSA custodians typically expose the cash side
and the invested side separately. It saves to `~/.config/ynab-simplefin-sync/mappings.json` and
prints a `SIMPLEFIN_MAP` string for CI.

Mappings are resolved from three places, in this order:

| Source | Where | Precedence |
|---|---|---|
| Note | `SIMPLEFIN:ACT-...` in the YNAB account note | highest |
| Config | `~/.config/ynab-simplefin-sync/mappings.json`, written by `link` | middle |
| Env | `SIMPLEFIN_MAP="<ynabId>=ACT-1+ACT-2;<ynabId2>=ACT-3"` | lowest |

The note wins because it is the only mapping visible from inside YNAB — letting an invisible
JSON file silently override what the note says would make a wrong balance very hard to explain.
`link` warns when a leftover note key is about to shadow what it just saved.

> **`link` cannot write the note for you.** The YNAB API is read-only for accounts — there is no
> PATCH/PUT endpoint, only `getAccounts`, `getAccountById` and `createAccount`. Notes can only be
> edited by hand in YNAB. That's why the config file exists; `link` prints the note text too, if
> you'd rather paste it in.

To map by hand instead, put the key anywhere in the account's note and run `discover` for the ids:

```
Roth IRA, opened 2019
SIMPLEFIN:ACT-8f3c1a02-...
```

## Setup

```bash
npm install -g ynab-simplefin-sync
```

Get a Setup Token from the SimpleFIN Bridge and exchange it once — Setup Tokens are single-use:

```bash
ynab-simplefin-sync claim <setup-token>
```

Save the printed Access URL as `SIMPLEFIN_ACCESS_URL`. It contains Basic Auth credentials, so
treat it as a secret; it is never logged unredacted.

```bash
export SIMPLEFIN_ACCESS_URL="https://...:...@bridge.simplefin.org/simplefin"
export YNAB_API_TOKEN="..."
export YNAB_BUDGET_ID="..."

ynab-simplefin-sync link          # interactively map accounts
ynab-simplefin-sync sync --dry-run
ynab-simplefin-sync sync
```

## Commands

| Command | Purpose |
|---|---|
| `sync` (default) | Fetch balances, reconcile, write to YNAB |
| `link` | Interactively pick YNAB accounts and their SimpleFIN counterparts |
| `discover` | List SimpleFIN accounts and which YNAB accounts map to them |
| `claim <token>` | Exchange a single-use Setup Token for an Access URL |

Flags: `--dry-run` (also `DRY_RUN=1`), `--force`, `--stale-hours <n>`, `--threshold <usd>`,
`--print-only` (link).

Exit codes: `0` clean, `1` fatal, `2` completed but something needs a human (a failed write,
a broken connection, or a tripped safety guard).

## Scheduling

SimpleFIN only re-pulls from institutions **once every 24 hours**, and the Bridge expects
**≤24 requests/day** — exceeding that disables the Access Token. Four runs a day catches the
refresh whenever it lands with plenty of headroom:

```yaml
on:
  schedule:
    - cron: "0 11,15,19,23 * * *"
```

Running hourly is within quota but buys nothing, since the upstream data won't have changed.

## Safety

A sync that goes wrong silently rewrites net worth, so:

- **A missing account is never treated as zero.** If a mapped id isn't in the response, it's
  skipped and reported.
- **Connection errors block writes.** If SimpleFIN reports an error scoped to a mapped account
  or its connection (MFA re-auth, institution down), that account is skipped.
- **Large adjustments are refused.** Any single delta above `max($25,000, 40% of the account's
  balance)` is blocked pending `--force`. Catches an institution briefly reporting a partial
  or zeroed balance.
- **Stale balances are flagged, not blocked.** Past 36 hours the memo is prefixed `STALE`; the
  last known balance is still the best available truth.
- **Non-USD and unparseable balances are skipped.**
- Balances are parsed from SimpleFIN's decimal *strings* digit-by-digit rather than through a
  float, so no representation error creeps into milliunits.

## Idempotency

Each adjustment carries an `import_id` of `SFIN:<hash8>:<YYYY-MM-DD>`. A second run on the same
day amends that transaction rather than stacking a new one, so four runs a day leave one row
behind. YNAB also rejects duplicate `import_id`s per account, which makes the create path safe
against races.

## Development

```bash
npm install
npm test        # builds, then runs node:test over the pure reconcile core
```

`src/reconcile.ts` is deliberately I/O-free — all the decision logic lives there and is tested
against fixtures, with `simplefin.ts` and `ynab.ts` reduced to transport.

## Releasing

Every push to `main` runs the tests, bumps the version, and publishes to npm automatically.
The bump level is read from the commit message:

| Commit message | Bump |
|---|---|
| `feat: ...` | minor |
| `feat!: ...` or a `BREAKING CHANGE` line | major |
| anything else | patch |

The bump commit is `release: vX.Y.Z [skip ci]`, which is what stops it retriggering the
workflow. Use `[skip ci]` in your own commit message to push without releasing, or run the
workflow manually from the Actions tab to force a specific level.

Requires an `NPM_TOKEN` repository secret (an npm **automation** token). Without it the
workflow still runs the tests and just skips the publish.

## License

MIT
