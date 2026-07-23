import test from "node:test";
import assert from "node:assert/strict";
import { clientIp, createApp } from "./server.js";
import { syncWorkflowYaml, repoReadme, buildMapValue } from "./public/templates.js";

// --- Templates -------------------------------------------------------------------------

test("workflow template pins the schedule and the package major", () => {
    const yaml = syncWorkflowYaml();
    assert.match(yaml, /- cron: "0 \*\/2 \* \* \*"/);
    assert.match(yaml, /npx ynab-simplefin-sync@3 sync/);
    assert.match(yaml, /workflow_dispatch:/);
    assert.match(yaml, /actions: write/);
    assert.match(yaml, /workflows\/sync\.yml\/enable/);
    assert.ok(!yaml.includes("\t"), "workflow must not contain tabs");
});

test("workflow references exactly the four provisioned secrets", () => {
    const yaml = syncWorkflowYaml();
    const secrets = [...yaml.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
    assert.deepEqual(
        [...new Set(secrets)].sort(),
        ["GITHUB_TOKEN", "SIMPLEFIN_ACCESS_URL", "SIMPLEFIN_MAP", "YNAB_API_TOKEN", "YNAB_BUDGET_ID"],
    );
});

test("readme names the budget and the secrets", () => {
    const md = repoReadme("My Budget");
    assert.match(md, /\*\*My Budget\*\*/);
    assert.match(md, /SIMPLEFIN_MAP/);
});

test("buildMapValue formats and skips unmapped accounts", () => {
    assert.equal(
        buildMapValue([
            { ynabAccountId: "y1", simplefinIds: ["ACT-1", "ACT-2"] },
            { ynabAccountId: "y2", simplefinIds: [] },
            { ynabAccountId: "y3", simplefinIds: ["ACT-3"] },
        ]),
        "y1=ACT-1+ACT-2;y3=ACT-3",
    );
});

test("clientIp trusts only the proxy-appended X-Forwarded-For entry", () => {
    const req = (xff, socketAddr = "10.0.0.1") => ({
        headers: xff === undefined ? {} : { "x-forwarded-for": xff },
        socket: { remoteAddress: socketAddr },
    });

    // Cloud Run appends the observed client IP last; earlier entries are client-supplied.
    assert.equal(clientIp(req("203.0.113.9")), "203.0.113.9");
    assert.equal(clientIp(req("spoofed.example, 203.0.113.9")), "203.0.113.9");
    assert.equal(clientIp(req(undefined)), "10.0.0.1");
    assert.equal(clientIp(req("  ")), "10.0.0.1");
});

// --- Server ----------------------------------------------------------------------------

const startServer = (env = {}) =>
    new Promise((resolve) => {
        const config = {
            port: 0,
            baseUrl: "https://app.example.com",
            clientId: env.clientId ?? "test-client-id",
            clientSecret: "test-secret",
            appSlug: "test-app",
            setupMode: false,
            simplefinHosts: ["simplefin.org"],
        };
        const server = createApp(config);
        server.listen(0, () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
    });

test("server routes", async (t) => {
    const { server, base } = await startServer();
    t.after(() => server.close());

    await t.test("healthz", async () => {
        const res = await fetch(`${base}/healthz`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true });
    });

    await t.test("serves the frontend with security headers", async () => {
        const res = await fetch(`${base}/`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type"), /text\/html/);
        assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
        assert.match(await res.text(), /Connect GitHub/);
    });

    await t.test("config endpoint exposes no secrets", async () => {
        const res = await fetch(`${base}/config`);
        const body = await res.json();
        assert.deepEqual(Object.keys(body).sort(), ["app_slug", "configured", "simplefin_hosts"]);
    });

    await t.test("login redirects to GitHub with a state cookie", async () => {
        const res = await fetch(`${base}/login`, { redirect: "manual" });
        assert.equal(res.status, 302);
        const location = res.headers.get("location");
        assert.match(location, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
        assert.match(location, /client_id=test-client-id/);
        assert.match(res.headers.get("set-cookie"), /oauth_state=[0-9a-f]{32}; HttpOnly/);
    });

    await t.test("callback rejects a state mismatch", async () => {
        const res = await fetch(`${base}/callback?code=x&state=y`, { redirect: "manual" });
        assert.equal(res.status, 400);
    });

    await t.test("static path traversal is blocked", async () => {
        const res = await fetch(`${base}/..%2f..%2fserver.js`);
        assert.notEqual(res.status, 200);
    });

    await t.test("claim rejects garbage and non-allowlisted hosts", async () => {
        let res = await fetch(`${base}/api/claim`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ setup_token: "!!!" }),
        });
        assert.equal(res.status, 400);

        // A valid base64 claim URL on a disallowed host must be refused (SSRF guard).
        const evil = Buffer.from("https://internal.corp.example/claim").toString("base64");
        res = await fetch(`${base}/api/claim`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ setup_token: evil }),
        });
        assert.equal(res.status, 400);
        assert.match((await res.json()).error, /unexpected host/);
    });

    await t.test("simplefin relay enforces the host allowlist", async () => {
        const res = await fetch(`${base}/api/simplefin/accounts`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ access_url: "https://user:pass@evil.example.com/simplefin" }),
        });
        assert.equal(res.status, 400);
    });

    await t.test("setup is disabled when a client id is configured", async () => {
        const res = await fetch(`${base}/setup`);
        assert.equal(res.status, 404);
    });
});

test("setup page is reachable when unconfigured and requests narrow permissions", async (t) => {
    const { server, base } = await startServer({ clientId: "" });
    t.after(() => server.close());

    const res = await fetch(`${base}/setup`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /settings\/apps\/new/);
    // Manifest is JSON.stringify'd then HTML-escaped into the form value.
    assert.match(html, /&quot;contents&quot;:&quot;write&quot;/);
    assert.match(html, /&quot;secrets&quot;:&quot;write&quot;/);
    assert.ok(!html.includes("administration"), "manifest must not request administration");
});
