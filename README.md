# ynab-simplefin-sync

[![CI](https://github.com/mbernhard7/ynab-simplefin-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/mbernhard7/ynab-simplefin-sync/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ynab-simplefin-sync)](https://www.npmjs.com/package/ynab-simplefin-sync)

Reconciles YNAB account balances against [SimpleFIN Bridge](https://beta-bridge.simplefin.org/):
it fetches what each account is actually worth and posts a single `Balance Adjustment` per account
for the difference. No positions, tickers, or price feeds.

Optionally it also picks payroll contributions out of the transaction feed and posts them as their
own transactions *first*, so the adjustment that follows covers only market movement.

```
$ ynab-simplefin-sync sync
[YSS] Fetching YNAB accounts...
[YSS] Found 5 mapped account(s) out of 23 (3 via note, 2 via config).
[YSS] Fetching SimpleFIN balances and 90d of history...
[YSS] Contributions (1):
      2026-08-01 Fidelity 401k: 401(k) Contribution $1,021.35
[YSS] Contributions: created=1 already-present=0 failed=0
[YSS] Plan:
      Robinhood Individual: $12,401.55 → $12,509.02 (+$107.47)
      Fidelity 401k: already matches at $61,200.00
      Vanguard Traditional: SKIPPED (connection-error) — needs re-authentication
[YSS] Posting 1 adjustment(s) to YNAB...
[YSS] Done. contributions=1 applied=1 failed=0 blocked=1
```

## Install

```bash
npm install -g ynab-simplefin-sync
```

Requires Node 20+.

## Quick start

```bash
ynab-simplefin-sync setup
```

A guided first run: paste a SimpleFIN Setup Token (claimed for you) or an Access URL, paste your
YNAB token, pick a budget, map accounts, and optionally choose accounts to archive. Then preview:

```bash
ynab-simplefin-sync sync --dry-run
```

The first real run posts a large catch-up adjustment and will trip the safety guard. Check the
numbers against what the institution shows, then apply once with `--force`. Daily deltas afterward
are small and run unforced.

## Commands

| Command | Purpose |
|---|---|
| `sync` (default) | Post payroll contributions, then reconcile and post one adjustment per account |
| `setup` | Guided first run: credentials, budget, mappings, archive |
| `link` | Map YNAB accounts to SimpleFIN accounts (`--archive` also picks archived accounts) |
| `discover` | List SimpleFIN and YNAB accounts |
| `claim <token>` | Exchange a single-use SimpleFIN Setup Token for an Access URL |
| `help` | Show usage |

| Flag | Applies to | Effect |
|---|---|---|
| `--dry-run` | `sync` | Print the plan, write nothing (also `DRY_RUN=1`) |
| `--force` | `sync` | Bypass the large-adjustment guard |
| `--stale-hours <n>` | `sync` | Staleness threshold, default 36 |
| `--threshold <usd>` | `sync` | Absolute floor for the guard, default 25000 |
| `--archive <dir>` | `sync` | Write snapshots to `<dir>` (also `ARCHIVE_DIR`) |
| `--no-contributions` | `sync` | Skip the contribution pass; adjustments absorb payroll deposits again |
| `--archive` | `link` | Also choose which accounts to archive |
| `--print-only` | `link` | Choose and print without saving |
| `--skip-link` | `setup` | Stop after credentials and budget |

Exit codes: `0` clean, `1` fatal, `2` completed but something needs a human (a failed write, a
broken connection, or a tripped guard).

## Configuration

Secrets are never written to the config. Environment always wins over the config file, and a
`./.env` is read before `~/.config/ynab-simplefin-sync/.env`.

| | Values | Source |
|---|---|---|
| **Secrets** | `YNAB_API_TOKEN`, `SIMPLEFIN_ACCESS_URL` | Environment, or `~/.config/ynab-simplefin-sync/.env` (mode 600) |
| **Settings** | `YNAB_BUDGET_ID`, `SIMPLEFIN_MAP`, `SIMPLEFIN_ARCHIVE_ACCOUNTS`, `SIMPLEFIN_CONTRIBUTIONS` | `~/.config/ynab-simplefin-sync/config.json`, each overridable by the matching env var |

## Mapping accounts

`link` lists your YNAB accounts, suggests a SimpleFIN match by name, and lets you choose.
Comma-separate (or `+` in a note) to sum several SimpleFIN accounts into one YNAB account.

Mappings resolve from three sources, highest precedence first:

| Source | Where |
|---|---|
| Note | `SIMPLEFIN:ACT-...` in the YNAB account note |
| Config | `mappings` in `config.json`, written by `link` |
| Env | `SIMPLEFIN_MAP="<ynabId>=ACT-1+ACT-2;<ynabId2>=ACT-3"` |

`link` cannot edit YNAB notes — the YNAB API is read-only for accounts — so it writes the config
and prints the note text if you would rather paste it in yourself.

## Archiving

Optional and off by default. `--archive <dir>` (or `ARCHIVE_DIR`) writes each selected account's
raw response object to `<dir>/<account-id>/<balance-date>.json`. Keyed by `balance-date`, a write
happens only when SimpleFIN has refreshed that account since the last snapshot, so frequent polling
stays quiet. The raw object is stored verbatim, keeping Bridge extensions such as `holdings`.

Choose accounts with `link --archive` (or during `setup`), or set `SIMPLEFIN_ARCHIVE_ACCOUNTS` to a
`;`-separated id list — or `all`, which also archives accounts you connect later. SimpleFIN serves a
rolling 90-day window, so anything not archived is unrecoverable once it ages out.

## Payroll contributions

Off by default. Employer 401(k) match and pre-tax deferrals never pass through a checking
account, so a balance-only sync folds them into `Balance Adjustment` — and they vanish from any
income or savings-rate figure. Add a `contributions` block to `config.json` (or the whole object
as `SIMPLEFIN_CONTRIBUTIONS`, which the scheduled job needs since CI has no config file):

```json
{
  "contributions": {
    "since": "2026-07-23",
    "rules": [
      {
        "simplefinId": "ACT-1865...",
        "match": "^contribution$",
        "sign": "negative",
        "payee": "401(k) Contribution",
        "reviewWindow": { "from": "01-10", "to": "02-15" }
      },
      {
        "simplefinId": "ACT-f9f6...",
        "match": "^employee payroll$",
        "sign": "positive",
        "payee": "HSA Payroll Contribution"
      }
    ]
  }
}
```

| Field | Meaning |
|---|---|
| `match` | Case-insensitive regex against `description`, then `payee`, then `memo` |
| `sign` | Which sign in the feed counts. Fidelity books contributions **negative** (cash buying into the funds); HSA Bank books them positive. The other sign is ignored, so a withdrawal can never post as income |
| `payee` | Payee on the YNAB transaction. Contributions are grouped per account, date and payee |
| `since` | Only feed transactions on or after this date, so history already in YNAB is left alone |
| `reviewWindow` | `MM-DD` range where a deposit may be an employer true-up rather than a deferral |

Enabling contributions makes `sync` request the 90-day transaction window instead of balances
only. It is still a single SimpleFIN request, so it does not count extra against the daily quota.

**The five legs are one contribution.** Fidelity splits a pay period across each fund in the
allocation; those rows are summed into one transaction per date.

**Employer match is flagged, never guessed.** Nothing in the feed separates a match from a
deferral — Fidelity labels every row `contribution` and splits both across the same funds in the
same ratio. A deposit inside `reviewWindow` is still posted (it is real money), but its memo is
prefixed `REVIEW` and the run logs a warning so you can retag it once a year.

## Scheduling (GitHub Actions)

SimpleFIN re-pulls from institutions roughly once a day, and the Bridge allows about 24 requests
per day. Each run makes one request, so schedule it a few times a day.

```yaml
name: YNAB Sync
on:
  schedule:
    - cron: "0 11,15,19,23 * * *"

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v5
        with:
          node-version: 20
      - run: npm install ynab-simplefin-sync@3
      - run: npx ynab-simplefin-sync sync
        env:
          YNAB_API_TOKEN: ${{ secrets.YNAB_API_TOKEN }}
          YNAB_BUDGET_ID: ${{ secrets.YNAB_BUDGET_ID }}
          SIMPLEFIN_ACCESS_URL: ${{ secrets.SIMPLEFIN_ACCESS_URL }}
          SIMPLEFIN_MAP: ${{ secrets.SIMPLEFIN_MAP }}
          SIMPLEFIN_ARCHIVE_ACCOUNTS: ${{ secrets.SIMPLEFIN_ARCHIVE_ACCOUNTS }}
          SIMPLEFIN_CONTRIBUTIONS: ${{ secrets.SIMPLEFIN_CONTRIBUTIONS }}
          ARCHIVE_DIR: archive/data
```

`SIMPLEFIN_MAP` is only needed for accounts mapped via `link` rather than a YNAB note.

## Safety

- **A missing account is never treated as zero** — it is skipped and reported, not reconciled to `$0`.
- **Connection errors block writes** for the affected account.
- **Large adjustments are refused.** Any delta above `max($25,000, 40% of the balance)` needs `--force`.
- **SimpleFIN lag never reverts YNAB.** If an account's newest YNAB transaction is later than SimpleFIN's `balance-date`, the account is skipped (`ynab-ahead`) until SimpleFIN catches up. `--force` overrides it; this skip does not fail the run.
- **Stale balances are flagged, not blocked** — past 36 hours the memo is prefixed `STALE`.
- **Non-USD and unparseable balances are skipped.**
- **Contributions are posted before the balance is read again.** The adjustment then measures the
  gap that is left, so the same money is never posted twice. A dry run models the same effect.
- **A contribution rule only ever creates inflows.** The `sign` filter drops feed rows carrying
  the opposite sign, so a distribution cannot be booked as income.
- Balances are parsed digit-by-digit, and writes to one budget are sequential.

Each adjustment carries a stable `import_id` (`SFIN:<hash8>:<YYYY-MM-DD>`), so repeated runs the
same day amend one transaction instead of stacking new ones.

## Development

```bash
npm install
npm test
```

`src/reconcile.ts` and `src/contributions.ts` are I/O-free and hold all reconciliation and
classification logic; `simplefin.ts` and `ynab.ts` are transport. Pushes to `main` run the tests, bump the version from the commit message
(`feat:` minor, `feat!:`/`BREAKING CHANGE` major, else patch), and publish to npm.

## License

MIT
