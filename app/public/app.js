import { syncWorkflowYaml, repoReadme, buildMapValue } from "/templates.js";

const state = {
    ghToken: null,
    ghLogin: null,
    accessUrl: null,
    simplefinAccounts: [],
    ynabToken: null,
    budgets: [],
    budgetId: null,
    budgetName: null,
    ynabAccounts: [],
    appSlug: "",
};

const $ = (id) => document.getElementById(id);

const setStatus = (id, text, kind = "") => {
    const el = $(id);
    el.textContent = text;
    el.className = `status ${kind}`;
};

const unlock = (id) => $(id).classList.remove("locked");

// --- API helpers -----------------------------------------------------------------------

const gh = async (path, options = {}) => {
    const res = await fetch(`https://api.github.com${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${state.ghToken}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...options.headers,
        },
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(body.message ?? `GitHub ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return res.status === 204 ? null : res.json();
};

const ynab = async (path) => {
    const res = await fetch(`https://api.ynab.com/v1${path}`, {
        headers: { Authorization: `Bearer ${state.ynabToken}` },
    });
    if (!res.ok) throw new Error(res.status === 401 ? "YNAB rejected the token." : `YNAB API ${res.status}`);
    return (await res.json()).data;
};

const relay = async (path, body) => {
    const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `relay ${res.status}`);
    return data;
};

const toBase64 = (text) => {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
};

// --- Step 1: GitHub --------------------------------------------------------------------

const pickUpToken = () => {
    const match = location.hash.match(/ghtok=([^&]+)/);
    if (match) {
        sessionStorage.setItem("ghtok", decodeURIComponent(match[1]));
        history.replaceState(null, "", location.pathname);
    }
    return sessionStorage.getItem("ghtok");
};

const initGithub = async () => {
    const token = pickUpToken();
    if (!token) return;

    state.ghToken = token;
    try {
        const user = await gh("/user");
        state.ghLogin = user.login;
        $("github-connect").classList.add("hidden");
        setStatus("github-status", `Connected as @${user.login} ✓`, "ok");
        unlock("step-simplefin");
    } catch {
        sessionStorage.removeItem("ghtok");
        setStatus("github-status", "Session expired — connect again.", "error");
    }
};

// --- Step 2: SimpleFIN -----------------------------------------------------------------

const looksLikeAccessUrl = (v) => /^https:\/\/[^/]+:[^/]+@/.test(v);

/** Browser-direct first (in case the Bridge ever enables CORS), relay fallback. */
const fetchSimplefinAccounts = async (accessUrl) => {
    try {
        const base = new URL(accessUrl.replace(/\/+$/, ""));
        const username = decodeURIComponent(base.username);
        const password = decodeURIComponent(base.password);
        base.username = "";
        base.password = "";
        const url = new URL(`${base.toString()}/accounts`);
        url.searchParams.set("balances-only", "1");
        url.searchParams.set("start-date", String(Math.floor(Date.now() / 1000)));
        const res = await fetch(url, { headers: { Authorization: `Basic ${btoa(`${username}:${password}`)}` } });
        if (!res.ok) throw new Error(`SimpleFIN ${res.status}`);
        return await res.json();
    } catch {
        return relay("/api/simplefin/accounts", { access_url: accessUrl });
    }
};

const verifySimplefin = async () => {
    const value = $("simplefin-input").value.trim();
    if (!value) return setStatus("simplefin-status", "Paste a Setup Token or Access URL first.", "error");

    setStatus("simplefin-status", "Verifying…");
    try {
        const accessUrl = looksLikeAccessUrl(value)
            ? value
            : (await relay("/api/claim", { setup_token: value })).access_url;

        const data = await fetchSimplefinAccounts(accessUrl);
        if (!Array.isArray(data.accounts) || data.accounts.length === 0) {
            throw new Error("SimpleFIN returned no accounts. Connect an institution on the Bridge first.");
        }

        state.accessUrl = accessUrl;
        state.simplefinAccounts = data.accounts;
        setStatus("simplefin-status", `Found ${data.accounts.length} account(s) ✓`, "ok");
        unlock("step-ynab");
    } catch (err) {
        setStatus("simplefin-status", err.message, "error");
    }
};

// --- Step 3: YNAB ----------------------------------------------------------------------

const verifyYnab = async () => {
    const token = $("ynab-input").value.trim();
    if (!token) return setStatus("ynab-status", "Paste a YNAB token first.", "error");

    state.ynabToken = token;
    setStatus("ynab-status", "Fetching budgets…");
    try {
        const { budgets } = await ynab("/budgets");
        if (budgets.length === 0) throw new Error("That token can't see any budgets.");
        state.budgets = budgets;

        const select = $("budget-select");
        select.replaceChildren(
            ...budgets.map((b) => {
                const option = document.createElement("option");
                option.value = b.id;
                option.textContent = b.name;
                return option;
            }),
        );
        $("budget-row").classList.remove("hidden");
        setStatus("ynab-status", budgets.length === 1 ? `Using your only budget: ${budgets[0].name}` : "Pick a budget.");
        await chooseBudget();
    } catch (err) {
        setStatus("ynab-status", err.message, "error");
    }
};

const chooseBudget = async () => {
    state.budgetId = $("budget-select").value;
    state.budgetName = state.budgets.find((b) => b.id === state.budgetId)?.name ?? "YNAB";
    setStatus("ynab-status", "Fetching accounts…");
    try {
        const { accounts } = await ynab(`/budgets/${state.budgetId}/accounts`);
        state.ynabAccounts = accounts.filter((a) => !a.deleted && !a.closed);
        if (state.ynabAccounts.length === 0) throw new Error("No open accounts in that budget.");
        setStatus("ynab-status", `${state.ynabAccounts.length} open account(s) ✓`, "ok");
        renderMapping();
        unlock("step-map");
        unlock("step-create");
    } catch (err) {
        setStatus("ynab-status", err.message, "error");
    }
};

// --- Step 4: Mapping -------------------------------------------------------------------

const money = (milliunits) =>
    (milliunits / 1000).toLocaleString("en-US", { style: "currency", currency: "USD" });

const renderMapping = () => {
    const container = $("mapping-list");
    container.replaceChildren(
        ...state.ynabAccounts.map((account) => {
            const details = document.createElement("details");
            const summary = document.createElement("summary");
            summary.dataset.accountId = account.id;
            details.append(summary);

            for (const sf of state.simplefinAccounts) {
                const label = document.createElement("label");
                const checkbox = document.createElement("input");
                checkbox.type = "checkbox";
                checkbox.dataset.ynab = account.id;
                checkbox.dataset.simplefin = sf.id;
                checkbox.addEventListener("change", updateMapStatus);
                const org = sf.org?.name ?? sf.org?.domain ?? "?";
                label.append(checkbox, ` ${org} · ${sf.name} — $${sf.balance}`);
                details.append(label);
            }
            return details;
        }),
    );
    updateMapStatus();
};

const currentMappings = () =>
    state.ynabAccounts
        .map((account) => ({
            ynabAccountId: account.id,
            simplefinIds: [...document.querySelectorAll(`input[data-ynab="${account.id}"]:checked`)].map(
                (c) => c.dataset.simplefin,
            ),
        }))
        .filter((m) => m.simplefinIds.length > 0);

const updateMapStatus = () => {
    for (const summary of document.querySelectorAll("#mapping-list summary")) {
        const account = state.ynabAccounts.find((a) => a.id === summary.dataset.accountId);
        const picked = document.querySelectorAll(`input[data-ynab="${account.id}"]:checked`).length;
        summary.textContent = `${account.name} — ${money(account.balance)} — ${
            picked > 0 ? `${picked} mapped ✓` : "not mapped"
        }`;
    }
    const count = currentMappings().length;
    setStatus("map-status", count > 0 ? `${count} account(s) will sync.` : "Map at least one account to continue.");
};

// --- Step 5: Provision -----------------------------------------------------------------

const log = (line) => {
    const el = $("create-log");
    el.classList.remove("hidden");
    el.textContent += `${line}\n`;
};

/** Create-or-update a file via the contents API. */
const putFile = async (repo, path, content, message) => {
    let sha;
    try {
        const existing = await gh(`/repos/${state.ghLogin}/${repo}/contents/${path}`);
        sha = existing.sha;
    } catch (err) {
        if (err.status !== 404) throw err;
    }
    await gh(`/repos/${state.ghLogin}/${repo}/contents/${path}`, {
        method: "PUT",
        body: JSON.stringify({ message, content: toBase64(content), ...(sha ? { sha } : {}) }),
    });
};

const putSecret = async (repo, keyData, name, value) => {
    const sealed = sodium.crypto_box_seal(
        sodium.from_string(value),
        sodium.from_base64(keyData.key, sodium.base64_variants.ORIGINAL),
    );
    await gh(`/repos/${state.ghLogin}/${repo}/actions/secrets/${name}`, {
        method: "PUT",
        body: JSON.stringify({
            encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL),
            key_id: keyData.key_id,
        }),
    });
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const provision = async () => {
    const repo = $("repo-name").value.trim();
    const mappings = currentMappings();

    if (!/^[A-Za-z0-9._-]+$/.test(repo)) return setStatus("map-status", "Invalid repository name.", "error");
    if (mappings.length === 0) return setStatus("map-status", "Map at least one account first.", "error");

    $("create-button").disabled = true;
    $("create-log").textContent = "";

    try {
        await sodium.ready;

        log(`Checking access to ${state.ghLogin}/${repo}…`);
        try {
            await gh(`/repos/${state.ghLogin}/${repo}`);
            log("  accessible ✓");
        } catch (err) {
            if (err.status === 404 || err.status === 403) {
                throw new Error(
                    `Can't access ${state.ghLogin}/${repo}. Create the repository (step 1 link), ` +
                    "then install this app on it (step 2 link, “Only select repositories”), then try again.",
                );
            }
            throw err;
        }

        log("Adding workflow…");
        await putFile(repo, ".github/workflows/sync.yml", syncWorkflowYaml(), "Add sync workflow");

        log("Writing README…");
        await putFile(repo, "README.md", repoReadme(state.budgetName), "Configure sync");

        log("Sealing secrets in this browser…");
        const keyData = await gh(`/repos/${state.ghLogin}/${repo}/actions/secrets/public-key`);
        for (const [name, value] of [
            ["SIMPLEFIN_ACCESS_URL", state.accessUrl],
            ["YNAB_API_TOKEN", state.ynabToken],
            ["YNAB_BUDGET_ID", state.budgetId],
            ["SIMPLEFIN_MAP", buildMapValue(mappings)],
        ]) {
            await putSecret(repo, keyData, name, value);
            log(`  ${name} ✓`);
        }

        log("Starting a dry run…");
        let dispatched = false;
        for (let attempt = 0; attempt < 6 && !dispatched; attempt += 1) {
            try {
                await gh(`/repos/${state.ghLogin}/${repo}/actions/workflows/sync.yml/dispatches`, {
                    method: "POST",
                    body: JSON.stringify({ ref: "main", inputs: { dry_run: "true" } }),
                });
                dispatched = true;
            } catch {
                await sleep(3000); // workflow indexing lags the file push briefly
            }
        }
        log(dispatched ? "  dry run started ✓" : "  couldn't start a dry run — run it from the Actions tab.");

        $("done-repo").href = `https://github.com/${state.ghLogin}/${repo}`;
        $("done-actions").href = `https://github.com/${state.ghLogin}/${repo}/actions`;
        $("done-panel").classList.remove("hidden");
    } catch (err) {
        log(`ERROR: ${err.message}`);
        $("create-button").disabled = false;
    }
};

// --- Wire up ---------------------------------------------------------------------------

const init = async () => {
    try {
        const config = await (await fetch("/config")).json();
        state.appSlug = config.app_slug ?? "";
    } catch {
        // non-fatal
    }

    if (state.appSlug) {
        $("install-link").href = `https://github.com/apps/${state.appSlug}/installations/new`;
    }
    $("repo-name").addEventListener("input", () => {
        $("new-repo-link").href = `https://github.com/new?name=${encodeURIComponent($("repo-name").value.trim())}`;
    });

    $("simplefin-verify").addEventListener("click", verifySimplefin);
    $("ynab-verify").addEventListener("click", verifyYnab);
    $("budget-select").addEventListener("change", chooseBudget);
    $("create-button").addEventListener("click", provision);

    await initGithub();
};

init();
