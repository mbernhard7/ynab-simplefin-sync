// Templates for the files provisioned into a user's sync repository.
// Pure module: no DOM, no globals — imported by both the browser app and the tests.

/** Workflow for the generated repo. `minute` staggers schedules across users. */
export const syncWorkflowYaml = (minute) => {
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
        throw new Error(`minute must be 0-59, got ${minute}`);
    }

    return [
        "name: YNAB SimpleFIN Sync",
        "",
        "on:",
        "  schedule:",
        `    - cron: "${minute} */6 * * *"`,
        "  workflow_dispatch:",
        "    inputs:",
        "      dry_run:",
        '        description: "Print the plan without writing to YNAB"',
        "        type: boolean",
        "        default: false",
        "      force:",
        '        description: "Bypass the large-adjustment safety guard"',
        "        type: boolean",
        "        default: false",
        "",
        "permissions:",
        "  actions: write # lets the keepalive step reset the schedule's inactivity timer",
        "  contents: read",
        "",
        "jobs:",
        "  sync:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/setup-node@v5",
        "        with:",
        "          node-version: 22",
        "",
        "      - name: Sync",
        "        env:",
        "          YNAB_API_TOKEN: ${{ secrets.YNAB_API_TOKEN }}",
        "          YNAB_BUDGET_ID: ${{ secrets.YNAB_BUDGET_ID }}",
        "          SIMPLEFIN_ACCESS_URL: ${{ secrets.SIMPLEFIN_ACCESS_URL }}",
        "          SIMPLEFIN_MAP: ${{ secrets.SIMPLEFIN_MAP }}",
        "          DRY_RUN: ${{ inputs.dry_run && '1' || '' }}",
        "        run: npx ynab-simplefin-sync@3 sync ${{ inputs.force && '--force' || '' }}",
        "",
        "      # GitHub disables scheduled workflows after 60 days without repo activity;",
        "      # re-enabling our own workflow on every run resets that timer.",
        "      - name: Keep schedule alive",
        "        if: always()",
        "        run: |",
        "          curl -sf -X PUT \\",
        '            -H "Authorization: Bearer ${{ secrets.GITHUB_TOKEN }}" \\',
        '            -H "Accept: application/vnd.github+json" \\',
        '            "${{ github.api_url }}/repos/${{ github.repository }}/actions/workflows/sync.yml/enable"',
        "",
    ].join("\n");
};

/** README for the generated repo. */
export const repoReadme = (budgetName) => [
    "# YNAB ↔ SimpleFIN sync",
    "",
    `Keeps the **${budgetName}** budget's mapped account balances in sync with SimpleFIN,`,
    "using [ynab-simplefin-sync](https://github.com/mbernhard7/ynab-simplefin-sync).",
    "It runs on a schedule in this repository's GitHub Actions — your credentials live only",
    "in this repo's encrypted Actions secrets, readable by nobody (including the app that",
    "created this repo).",
    "",
    "## How it works",
    "",
    "Every 6 hours the workflow fetches your SimpleFIN balances and posts one",
    "`Balance Adjustment` per mapped account in YNAB for any difference. Runs are",
    "idempotent: repeated runs the same day amend a single transaction.",
    "",
    "## First run",
    "",
    "The first real sync posts a catch-up adjustment covering existing drift, which may",
    "trip the large-adjustment safety guard (shown as a red run with `blocked`). Check the",
    "numbers in the run log, then re-run once with force: **Actions → YNAB SimpleFIN Sync →",
    "Run workflow → force**.",
    "",
    "## Configuration",
    "",
    "| Secret | Purpose |",
    "|---|---|",
    "| `SIMPLEFIN_ACCESS_URL` | SimpleFIN credential (rotate at the SimpleFIN Bridge) |",
    "| `YNAB_API_TOKEN` | YNAB personal access token |",
    "| `YNAB_BUDGET_ID` | The budget to sync |",
    "| `SIMPLEFIN_MAP` | Account mapping: `<ynabId>=ACT-1+ACT-2;<ynabId2>=ACT-3` |",
    "",
    "Update any of them under **Settings → Secrets and variables → Actions**. To change the",
    "schedule, edit the `cron` line in `.github/workflows/sync.yml`. SimpleFIN allows about",
    "24 requests per day; each run makes one.",
    "",
].join("\n");

/** Builds the SIMPLEFIN_MAP value from mapping pairs. */
export const buildMapValue = (mappings) =>
    mappings
        .filter((m) => m.simplefinIds.length > 0)
        .map((m) => `${m.ynabAccountId}=${m.simplefinIds.join("+")}`)
        .join(";");
