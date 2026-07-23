# ynab-simplefin-app

Onboarding web app for [ynab-simplefin-sync](../README.md). A user connects GitHub, SimpleFIN,
and YNAB in the browser; the app provisions a **private repository in their account** that runs
the sync on a GitHub Actions schedule.

## Zero credential custody

The server never stores credentials, and never sees most of them:

| Credential | Path |
|---|---|
| YNAB token | Browser → YNAB API and browser → sealed repo secret. Never touches this server. |
| GitHub token | Short-lived OAuth user token; exchanged by the server, delivered to the browser in a URL fragment, held in `sessionStorage`. Never stored. Scoped to the single repository the user installed the app on. |
| SimpleFIN access URL | Relayed through this server per request (the Bridge sends no CORS headers), never stored or logged. Stored only as the repo's sealed secret. |

Secrets are sealed in the browser with libsodium (`crypto_box_seal`) against the repository's
public key and written directly to GitHub — encrypted end-to-end; only GitHub Actions can read
them. The generated workflow keeps its own schedule alive by resetting GitHub's 60-day
inactivity timer each run, so no PAT is ever needed.

## Architecture

- `server.js` — zero-dependency Node server: static frontend, GitHub OAuth code exchange,
  stateless SimpleFIN relay (host-allowlisted), one-time GitHub App manifest setup.
- `public/app.js` — the wizard. All GitHub/YNAB API calls run client-side.
- `public/templates.js` — the workflow + README provisioned into user repos.
- `public/vendor/` — libsodium-wrappers `0.7.15`, vendored from npm
  (`libsodium.js` sha256 `0a66b0fd…`, `libsodium-wrappers.js` sha256 `82888473…`).

## One-time setup

1. Deploy with no `GITHUB_CLIENT_ID` set, then open `/setup`. It creates the GitHub App via
   GitHub's manifest flow and shows `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and
   `GITHUB_APP_SLUG` once.
2. Set those as environment variables and redeploy. `/setup` disables itself once a client id
   is configured.

The app requests repository permissions: Contents (write), Workflows (write), Secrets (write),
Metadata (read) — no administration access. Users create the sync repository themselves and
install the app with **Only select repositories**, scoped to that single repo, so the grant
never extends past the one repository they picked.

## Environment

| Variable | Purpose |
|---|---|
| `BASE_URL` | Public URL of the deployment (no trailing slash) |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | From `/setup` |
| `GITHUB_APP_SLUG` | From `/setup`; used for install links |
| `SIMPLEFIN_ALLOWED_HOSTS` | Relay allowlist, default `simplefin.org` |
| `SETUP_MODE` | `1` re-enables `/setup` after configuration |
| `PORT` | Default `8080` |

## Deploy (Cloud Run)

```bash
gcloud run deploy ynab-simplefin-app \
  --source app --region us-east1 --allow-unauthenticated \
  --set-env-vars BASE_URL=https://<your-url>,GITHUB_CLIENT_ID=...,GITHUB_APP_SLUG=... \
  --set-secrets GITHUB_CLIENT_SECRET=github-client-secret:latest
```

## Develop

```bash
node app/server.js         # http://localhost:8080 (/setup enabled until configured)
node --test app/           # smoke tests
```
