// Onboarding server for ynab-simplefin-sync.
//
// Deliberately thin: the browser does the real work (GitHub API, YNAB API, secret
// sealing). This server only (1) serves the static frontend, (2) performs the GitHub
// OAuth code exchange — the client secret cannot live in the browser — and (3) relays
// SimpleFIN requests, because the Bridge does not send CORS headers. The relay is
// stateless: nothing is stored, nothing sensitive is logged.
//
// Zero runtime dependencies. Node 20+.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PUBLIC_DIR = fileURLToPath(new URL("./public", import.meta.url));

const CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
};

const SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": [
        "default-src 'self'",
        "connect-src 'self' https://api.github.com https://api.ynab.com https://beta-bridge.simplefin.org https://bridge.simplefin.org",
        "script-src 'self' 'wasm-unsafe-eval'",
        "style-src 'self'",
        "img-src 'self' data:",
        "frame-ancestors 'none'",
        "base-uri 'none'",
    ].join("; "),
};

export const defaultConfig = () => ({
    port: Number(process.env.PORT) || 8080,
    baseUrl: (process.env.BASE_URL || "").replace(/\/+$/, ""),
    clientId: process.env.GITHUB_CLIENT_ID || "",
    clientSecret: process.env.GITHUB_CLIENT_SECRET || "",
    appSlug: process.env.GITHUB_APP_SLUG || "",
    setupMode: process.env.SETUP_MODE === "1",
    // SSRF guard for the SimpleFIN relay: only these hosts (or their subdomains) may be
    // reached. Override for a self-hosted SimpleFIN server.
    simplefinHosts: (process.env.SIMPLEFIN_ALLOWED_HOSTS || "simplefin.org")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
});

const hostAllowed = (hostname, allowed) => {
    const h = hostname.toLowerCase();
    return allowed.some((base) => h === base || h.endsWith(`.${base}`));
};

const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    res.end(body);
};

const sendJson = (res, status, obj) =>
    send(res, status, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8" });

const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const htmlPage = (title, body) =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<link rel="stylesheet" href="/style.css"></head><body><main class="narrow">${body}</main></body></html>`;

/** Reads a JSON request body with a size cap. */
const readJsonBody = (req, limit = 16 * 1024) =>
    new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error("body too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
            } catch {
                reject(new Error("invalid JSON"));
            }
        });
        req.on("error", reject);
    });

const parseCookies = (header = "") =>
    Object.fromEntries(
        header
            .split(";")
            .map((c) => c.trim().split("="))
            .filter((p) => p.length === 2),
    );

/** Naive fixed-window rate limiter, per IP, for the relay endpoints. */
const makeRateLimiter = (max = 30, windowMs = 60_000) => {
    const hits = new Map();
    return (ip) => {
        const now = Date.now();
        const entry = hits.get(ip);
        if (!entry || now - entry.start > windowMs) {
            hits.set(ip, { start: now, count: 1 });
            if (hits.size > 10_000) hits.clear();
            return true;
        }
        entry.count += 1;
        return entry.count <= max;
    };
};

export const createApp = (config = defaultConfig()) => {
    const allowRate = makeRateLimiter();

    const serveStatic = async (res, urlPath) => {
        const clean = normalize(urlPath === "/" ? "/index.html" : urlPath).replace(/^(\.\.[/\\])+/, "");
        const filePath = join(PUBLIC_DIR, clean);
        if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 404, "not found");

        try {
            const body = await readFile(filePath);
            const type = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
            const cache = extname(filePath) === ".html" ? "no-store" : "public, max-age=300";
            send(res, 200, body, { "Content-Type": type, "Cache-Control": cache });
        } catch {
            send(res, 404, "not found");
        }
    };

    // --- OAuth -----------------------------------------------------------------------

    const login = (res) => {
        if (!config.clientId) {
            if (config.setupMode) return send(res, 302, "", { Location: "/setup" });
            return send(res, 500, "GITHUB_CLIENT_ID is not configured.");
        }

        const state = randomBytes(16).toString("hex");
        const url = new URL("https://github.com/login/oauth/authorize");
        url.searchParams.set("client_id", config.clientId);
        url.searchParams.set("state", state);
        if (config.baseUrl) url.searchParams.set("redirect_uri", `${config.baseUrl}/callback`);

        send(res, 302, "", {
            Location: url.toString(),
            "Set-Cookie": `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/`,
        });
    };

    const callback = async (req, res, url) => {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const cookieState = parseCookies(req.headers.cookie).oauth_state;

        if (!code || !state || !cookieState || state !== cookieState) {
            return send(res, 400, "OAuth state mismatch. Start again from the home page.");
        }

        const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({
                client_id: config.clientId,
                client_secret: config.clientSecret,
                code,
            }),
        });
        const data = await tokenRes.json().catch(() => ({}));

        if (!data.access_token) {
            return send(res, 502, `GitHub token exchange failed: ${escapeHtml(data.error ?? tokenRes.status)}`);
        }

        // The token travels in the URL fragment, which browsers do not send to servers.
        // The frontend stores it in sessionStorage and strips the fragment immediately.
        send(res, 302, "", {
            Location: `/#ghtok=${encodeURIComponent(data.access_token)}`,
            "Set-Cookie": "oauth_state=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/",
        });
    };

    // --- SimpleFIN relay (stateless; Bridge sends no CORS headers) ---------------------

    const claim = async (req, res) => {
        const { setup_token: setupToken } = await readJsonBody(req);
        if (typeof setupToken !== "string" || setupToken.trim() === "") {
            return sendJson(res, 400, { error: "setup_token is required" });
        }

        let claimUrl;
        try {
            claimUrl = new URL(Buffer.from(setupToken.trim(), "base64").toString("utf8").trim());
        } catch {
            return sendJson(res, 400, { error: "Setup token did not decode to a URL. Paste it in full." });
        }
        if (claimUrl.protocol !== "https:" || !hostAllowed(claimUrl.hostname, config.simplefinHosts)) {
            return sendJson(res, 400, { error: "Setup token points at an unexpected host." });
        }

        const upstream = await fetch(claimUrl, { method: "POST", headers: { "Content-Length": "0" } });
        if (!upstream.ok) {
            return sendJson(res, 502, {
                error: `Claim failed (${upstream.status}). Setup tokens are single-use — generate a fresh one.`,
            });
        }

        const accessUrl = (await upstream.text()).trim();
        if (!/^https:\/\/[^/]+:[^/]+@/.test(accessUrl)) {
            return sendJson(res, 502, { error: "Claim did not return an access URL." });
        }
        sendJson(res, 200, { access_url: accessUrl });
    };

    const simplefinAccounts = async (req, res) => {
        const { access_url: accessUrl } = await readJsonBody(req);
        if (typeof accessUrl !== "string") return sendJson(res, 400, { error: "access_url is required" });

        let base;
        try {
            base = new URL(accessUrl.replace(/\/+$/, ""));
        } catch {
            return sendJson(res, 400, { error: "access_url is not a URL" });
        }
        if (base.protocol !== "https:" || !hostAllowed(base.hostname, config.simplefinHosts)) {
            return sendJson(res, 400, { error: "access_url points at an unexpected host." });
        }

        const username = decodeURIComponent(base.username);
        const password = decodeURIComponent(base.password);
        base.username = "";
        base.password = "";
        if (!username || !password) return sendJson(res, 400, { error: "access_url is missing credentials" });

        const url = new URL(`${base.toString()}/accounts`);
        url.searchParams.set("balances-only", "1");
        url.searchParams.set("start-date", String(Math.floor(Date.now() / 1000)));

        const upstream = await fetch(url, {
            headers: {
                Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
                Accept: "application/json",
            },
        });
        if (!upstream.ok) {
            return sendJson(res, 502, { error: `SimpleFIN returned ${upstream.status}` });
        }
        sendJson(res, 200, await upstream.json());
    };

    // --- One-time GitHub App creation via the manifest flow ----------------------------

    const manifest = () => ({
        name: "YNAB SimpleFIN Sync",
        url: config.baseUrl || "https://example.com",
        redirect_url: `${config.baseUrl}/setup/callback`,
        callback_urls: [`${config.baseUrl}/callback`],
        request_oauth_on_install: true,
        public: true,
        default_permissions: {
            administration: "write",
            contents: "write",
            workflows: "write",
            secrets: "write",
            metadata: "read",
        },
        default_events: [],
    });

    const setupPage = (res) =>
        send(
            res,
            200,
            htmlPage(
                "Create the GitHub App",
                `<h1>Create the GitHub App</h1>
                 <p>This posts an app manifest to GitHub. You confirm the app name there, and GitHub
                 sends back credentials which are shown once — never stored.</p>
                 <form action="https://github.com/settings/apps/new" method="post">
                   <input type="hidden" name="manifest" value='${escapeHtml(JSON.stringify(manifest()))}'>
                   <button type="submit">Create app on GitHub</button>
                 </form>`,
            ),
            { "Content-Type": "text/html; charset=utf-8" },
        );

    const setupCallback = async (res, url) => {
        const code = url.searchParams.get("code");
        if (!code) return send(res, 400, "Missing code.");

        const conv = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
            method: "POST",
            headers: { Accept: "application/vnd.github+json" },
        });
        if (!conv.ok) return send(res, 502, `Manifest conversion failed (${conv.status}).`);
        const app = await conv.json();

        send(
            res,
            200,
            htmlPage(
                "App created",
                `<h1>App created: ${escapeHtml(app.name)}</h1>
                 <p>Set these environment variables on the server, then restart. They are shown once.</p>
                 <pre>GITHUB_CLIENT_ID=${escapeHtml(app.client_id)}
GITHUB_CLIENT_SECRET=${escapeHtml(app.client_secret)}
GITHUB_APP_SLUG=${escapeHtml(app.slug)}</pre>
                 <p>App settings: <a href="${escapeHtml(app.html_url)}">${escapeHtml(app.html_url)}</a></p>`,
            ),
            { "Content-Type": "text/html; charset=utf-8" },
        );
    };

    // --- Router ------------------------------------------------------------------------

    return createServer(async (req, res) => {
        const url = new URL(req.url, "http://localhost");
        const route = `${req.method} ${url.pathname}`;

        try {
            if (route === "GET /healthz") return sendJson(res, 200, { ok: true });
            if (route === "GET /config") {
                return sendJson(res, 200, {
                    configured: Boolean(config.clientId),
                    app_slug: config.appSlug,
                    simplefin_hosts: config.simplefinHosts,
                });
            }
            if (route === "GET /login") return login(res);
            if (route === "GET /install") {
                if (!config.appSlug) return send(res, 404, "GITHUB_APP_SLUG is not configured.");
                return send(res, 302, "", {
                    Location: `https://github.com/apps/${config.appSlug}/installations/new`,
                });
            }
            if (route === "GET /callback") return await callback(req, res, url);

            if (url.pathname.startsWith("/api/")) {
                const ip = req.socket.remoteAddress ?? "unknown";
                if (!allowRate(ip)) return sendJson(res, 429, { error: "Slow down." });
                if (route === "POST /api/claim") return await claim(req, res);
                if (route === "POST /api/simplefin/accounts") return await simplefinAccounts(req, res);
                return sendJson(res, 404, { error: "not found" });
            }

            const setupAllowed = config.setupMode || !config.clientId;
            if (route === "GET /setup" && setupAllowed) return setupPage(res);
            if (route === "GET /setup/callback" && setupAllowed) return await setupCallback(res, url);

            if (req.method === "GET") return await serveStatic(res, url.pathname);
            send(res, 405, "method not allowed");
        } catch (err) {
            // Never echo request contents back; message only.
            sendJson(res, 500, { error: err instanceof Error ? err.message : "internal error" });
        }
    });
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const config = defaultConfig();
    createApp(config).listen(config.port, () => {
        console.log(`listening on :${config.port}${config.clientId ? "" : " (no GITHUB_CLIENT_ID — /setup enabled)"}`);
    });
}
