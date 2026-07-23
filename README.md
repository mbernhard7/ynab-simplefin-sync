# ynab-simplefin-sync

[![CI](https://github.com/mbernhard7/ynab-simplefin-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/mbernhard7/ynab-simplefin-sync/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ynab-simplefin-sync)](https://www.npmjs.com/package/ynab-simplefin-sync)

Keeps YNAB investment account balances honest by asking
[SimpleFIN Bridge](https://beta-bridge.simplefin.org/) what each account is actually worth and
posting a single adjustment for the difference.

No position tracking. No tickers. No price feed.

```
$ ynab-simplefin-sync sync
[YSS] Fetching YNAB accounts...
[YSS] Found 5 mapped account(s) out of 23 (3 via note, 2 via config).
[YSS] Fetching SimpleFIN balances...
[YSS] Plan:
      Robinhood Individual: $12,401.55 → $12,509.02 (+$107.47)
      Robinhood Roth IRA: $184,545.18 → $185,120.44 (+$575.26)
      Fidelity 401k: already matches at $61,200.00
      HSA Bank: $9,242.00 → $9,318.77 (+$76.77)
      Vanguard Traditional: SKIPPED (connection-error) — needs re-authentication
[YSS] Posting 3 adjustment(s) to YNAB...
[YSS] Done. applied=3 failed=0 blocked=1
```

## Why

The predecessor, [`ynab_investment_tracking`](https://github.com/mbernhard7/ynab-investment-tracker),
rebuilt holdings by replaying every YNAB transaction and parsing memos like `$VTI|BUY 12.5`,
then priced them through Yahoo Finance. That means every trade has to be hand-entered in an
exact format, delisted tickers silently freeze at their last value, 401k and HSA institutional
funds price badly or not at all, and one bad memo corrupts everything after it.

Asking the institution for the balance sidesteps all of it.

## How it works

1. Reads every mapped YNAB account (see [Mapping accounts](#mapping-accounts)).
2. Fetches all balances from SimpleFIN in **one** request.
3. Computes `simplefinBalance − ynabBalance` for each.
4. Posts — or amends — **one** `Balance Adjustment` transaction per account per day.

Account value in YNAB stays a running total that the adjustments steer, so your existing
transaction history is untouched and still explains how each balance got where it is.

## Install

```bash
npm install -g ynab-simplefin-sync
```

Requires Node 20+.

## Setup

```bash
ynab-simplefin-sync setup
```

One guided pass: paste your SimpleFIN Setup Token (it claims the Access URL for you) and your
YNAB token, pick your budget from a list, then map your accounts. When it finishes you are ready
for:

```bash
ynab-simplefin-sync sync --dry-run
```

Tokens are typed without echoing, and re-running `setup` offers to keep whatever is already
configured rather than making you paste it again. Pass `--skip-link` to stop after credentials.

The first real run will post a large catch-up adjustment covering the drift accumulated under
whatever you were doing before. Expect it to trip the safety guard — read the numbers, confirm
they match what the institution shows, then apply once with `--force`. After that, daily deltas
are small and run unforced.

### Where things are stored

Secrets and settings are kept apart on purpose. Nothing secret is ever written to the config.

| | Holds | Lives in |
|---|---|---|
| **Secrets** | `YNAB_API_TOKEN`, `SIMPLEFIN_ACCESS_URL` | Environment, or `~/.config/ynab-simplefin-sync/.env` (mode 600) |
| **Settings** | budget id, account mappings | `~/.config/ynab-simplefin-sync/config.json` |

Both settings have an environment override — `YNAB_BUDGET_ID` and `SIMPLEFIN_MAP` — which is how
CI works, since it has no writable config directory. **Environment always wins**, for secrets
and settings alike, so a `.env` that gets committed by accident can never shadow a real secret.

A `.env` in the current directory is read as well, before the one in the config directory.

### Doing it by hand instead

```bash
ynab-simplefin-sync claim <setup-token>   # Setup Tokens are single-use
export SIMPLEFIN_ACCESS_URL='https://user:pass@bridge.simplefin.org/simplefin'
export YNAB_API_TOKEN='...'               # YNAB → Settings → Developer Settings
export YNAB_BUDGET_ID='...'               # the uuid in the YNAB app URL
ynab-simplefin-sync link
```

The first real run will post a large catch-up adjustment covering the drift accumulated under
whatever you were doing before. Expect it to trip the safety guard — read the numbers, confirm
they match what the institution shows, then apply once with `--force`. After that, daily deltas
are small and run unforced.

## Mapping accounts

`link` lists your YNAB accounts, lets you pick which to map, then for each one shows the
SimpleFIN accounts — with a suggested match based on name similarity — and lets you choose.
Comma-separate to sum several SimpleFIN accounts into one YNAB account; HSA custodians
typically expose the cash side and the invested side separately.

Mappings resolve from three places:

| Source | Where | Precedence |
|---|---|---|
| Note | `SIMPLEFIN:ACT-...` in the YNAB account note | highest |
| Config | `mappings` in `~/.config/ynab-simplefin-sync/config.json`, written by `link` | middle |
| Env | `SIMPLEFIN_MAP="<ynabId>=ACT-1+ACT-2;<ynabId2>=ACT-3"` | lowest |

The note wins because it is the only mapping visible from inside YNAB — letting an invisible
JSON file silently override what the note says would make a wrong balance very hard to explain.
`link` warns when a leftover note key is about to shadow what it just saved.

> [!NOTE]
> **`link` cannot write the note for you.** The YNAB API is read-only for accounts — the spec
> exposes only `getAccounts`, `getAccountById` and `createAccount`, with no PATCH or PUT. Notes
> can only be edited by hand in YNAB. That is why the config file exists. `link` prints the note
> text as well, if you would rather paste it in.

To map by hand, put the key anywhere in the account's note and run `discover` for the ids:

```
Roth IRA, opened 2019
SIMPLEFIN:ACT-8f3c1a02-...
```

## Commands

| Command | Purpose |
|---|---|
| `setup` | Guided first run: credentials, budget, then mapping |
| `sync` (default) | Fetch balances, reconcile, write to YNAB |
| `link` | Interactively pick YNAB accounts and their SimpleFIN counterparts |
| `discover` | List SimpleFIN accounts and which YNAB accounts map to them |
| `select-archive` | Interactively pick which accounts the archive should include |
| `claim <token>` | Exchange a single-use Setup Token for an Access URL |

| Flag | Applies to | Effect |
|---|---|---|
| `--dry-run` | `sync` | Print the plan, write nothing (also `DRY_RUN=1`) |
| `--force` | `sync` | Bypass the large-adjustment guard |
| `--stale-hours <n>` | `sync` | Staleness threshold, default 36 |
| `--threshold <usd>` | `sync` | Absolute floor for the guard, default 25000 |
| `--skip-link` | `setup` | Stop after credentials and budget |
| `--archive <dir>` | `sync` | Also save the full 90-day response (also `ARCHIVE_DIR`) |
| `--print-only` | `link`, `select-archive` | Choose and print without saving |

Exit codes: `0` clean, `1` fatal, `2` completed but something needs a human — a failed write, a
broken connection, or a tripped guard.

## Scheduling

SimpleFIN re-pulls from institutions **once every 24 hours**, and the Bridge expects **≤24
requests/day** — exceeding that disables your Access Token. Four runs a day catches the refresh
whenever it lands, with headroom:

```yaml
name: YNAB Sync
on:
  schedule:
    - cron: "0 11,15,19,23 * * *"

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install ynab-simplefin-sync@2
      - run: npx ynab-simplefin-sync sync
        env:
          YNAB_API_TOKEN: ${{ secrets.YNAB_API_TOKEN }}
          YNAB_BUDGET_ID: ${{ secrets.YNAB_BUDGET_ID }}
          SIMPLEFIN_ACCESS_URL: ${{ secrets.SIMPLEFIN_ACCESS_URL }}
          SIMPLEFIN_MAP: ${{ secrets.SIMPLEFIN_MAP }}
          SIMPLEFIN_ARCHIVE_ACCOUNTS: ${{ secrets.SIMPLEFIN_ARCHIVE_ACCOUNTS }}
          ARCHIVE_DIR: archive/data
```

`SIMPLEFIN_MAP` is only needed for accounts mapped via `link` rather than a YNAB note — CI has
no writable config directory. `link` prints the value to paste in.

## Archiving

SimpleFIN serves a rolling **90-day** transaction window and nothing older, so anything not
captured is permanently lost. `--archive <dir>` (or `ARCHIVE_DIR`) writes each account's untouched
response object to `<dir>/<account-id>/<balance-date>.json`.

Storage is keyed by `balance-date` — SimpleFIN's own "as of" timestamp for the balance — so a
write is **idempotent per refresh**: a run only produces a file when SimpleFIN has actually
advanced that account since the last snapshot. Polling every couple of hours therefore writes
nothing until an institution refreshes, and each stored file is a distinct point-in-time balance
rather than one daily blob overwritten in place. (A malformed account with no `balance-date` is
archived once under `undated.json`.)

It rides on the sync's existing request — the Bridge's quota counts requests, not bytes — so
archiving 90 days of history costs no extra quota. The full window is re-fetched every run
rather than incrementally, because institutions post late: an observed dividend transacted
2026-06-23 posted on 2026-07-10.

The raw account object is stored rather than the parsed one, so nothing is lost to this tool's
schema — in particular `holdings`, which the Bridge returns as an extension beyond the published
v2 spec. Files are uncompressed on purpose: consecutive snapshots overlap heavily and git deltas
them to almost nothing, which per-file gzip would defeat.

By default every account is archived. To narrow it:

```bash
ynab-simplefin-sync select-archive
```

That saves `archiveAccounts` to the config and prints a `SIMPLEFIN_ARCHIVE_ACCOUNTS` value for
CI. Set it to `all` to archive everything, including accounts connected later.

> [!WARNING]
> Excluding an account is permanent in effect — once its transactions age past 90 days they
> cannot be retrieved. Exclude only what you are certain you will never want.

Running hourly is within quota but buys nothing, since the upstream data will not have changed.

## Safety

A sync that goes wrong silently rewrites your net worth, so:

- **A missing account is never treated as zero.** If a mapped id is absent from the response it
  is skipped and reported, not reconciled to `$0`.
- **Connection errors block writes.** If SimpleFIN reports an error scoped to a mapped account or
  its connection — MFA re-auth, institution down — that account is skipped.
- **Large adjustments are refused.** Any single delta above `max($25,000, 40% of the account
  balance)` is blocked pending `--force`. This catches an institution briefly reporting a partial
  or zeroed balance.
- **SimpleFIN lag never reverts YNAB.** If an account's newest YNAB transaction is dated later
  than SimpleFIN's `balance-date`, the institution has not refreshed since that transaction was
  added, and reconciling would undo it. The account is skipped (`ynab-ahead`) and logged, not
  reconciled, until SimpleFIN catches up. The tool's own balance adjustments are excluded from
  this check, and `--force` overrides it. This skip is informational — it does not turn a run red.
- **Stale balances are flagged, not blocked.** Past 36 hours the memo is prefixed `STALE`; the
  last known balance is still the best available truth.
- **Non-USD and unparseable balances are skipped.**
- **Balances are parsed digit-by-digit.** SimpleFIN reports decimal *strings*; `parseFloat(x) *
  1000` introduces representation error at exactly the magnitudes that matter.
- **Writes are sequential.** Concurrent writes to one budget race on `import_id` uniqueness.

## Idempotency

Each adjustment carries an `import_id` of `SFIN:<hash8>:<YYYY-MM-DD>` — the account uuid hashed
to 8 characters, because YNAB caps the field at 36. A second run the same day amends that
transaction instead of stacking a new one, so four runs a day leave a single row behind. YNAB
also rejects duplicate `import_id`s per account, which makes the create path safe against races.

## Development

```bash
npm install
npm test
```

`src/reconcile.ts` is deliberately I/O-free — every decision lives there and is tested against
fixtures, with `simplefin.ts` and `ynab.ts` reduced to transport. That separation is the point:
the predecessor had no tests, which is much of why it drifted.

| Module | Responsibility |
|---|---|
| `reconcile.ts` | Pure `(accounts, balances) → Plan[]`. All the logic. |
| `config.ts` | Config file, note / config / env resolution |
| `archive.ts` | Snapshot writing and account filtering |
| `setup.ts` | Guided first run |
| `link.ts` | Interactive picker |
| `simplefin.ts` | Claim + `/accounts`, response validation |
| `ynab.ts` | Account fetch, adjustment upsert |
| `env.ts` | `.env` loading, shell quoting |

## Releasing

Every push to `main` runs the tests, bumps the version, and publishes to npm. The bump level
comes from the commit message:

| Commit message | Bump |
|---|---|
| `feat: ...` | minor |
| `feat!: ...` or a `BREAKING CHANGE` line | major |
| anything else | patch |

The bump commit is `release: vX.Y.Z [skip ci]`, which is what stops it retriggering the
workflow. Use `[skip ci]` in your own commit message to push without releasing, or run the
workflow manually from the Actions tab to force a level.

Publishing uses npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) — GitHub
Actions authenticates over OIDC with short-lived, workflow-scoped credentials, so **no npm token
exists anywhere**. Provenance is signed automatically.

One-time setup, in order:

1. Publish the first version by hand (`npm publish --otp=<code>`). A trusted publisher is
   configured from the package's settings page, which requires the package to exist.
2. On npmjs.com → the package → **Settings → Trusted Publisher → GitHub Actions**, set
   organization/user, repository, and workflow filename `release.yml`.
3. Optionally disallow token-based publishing for the package, which is the whole point.

Until step 1 happens the workflow notices the package is absent, runs the tests, and skips the
publish rather than failing — then starts publishing on its own once it exists.

## License

MIT
