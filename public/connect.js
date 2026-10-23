let USERS = [];                    // from /users, in MINTY_USERS order (sets each person's colour)
let owner = null;
let capacity = null;
const statusEl = document.getElementById("status");
const connectBtn = document.getElementById("connect");

function setStatus(msg, kind="") { statusEl.textContent = msg; statusEl.className = "status " + kind; }
// The API's own words for a refusal ({"detail": ...}), else the status code.
const why = async res => { try { return (await res.json()).detail || res.status; } catch { return res.status; } };

// Link sessions (src/routes/link.ts): one localStorage entry each, minty_link:<session_id> =
// {id, token, mode: "link" | "update", item, expires}, so a bank's OAuth redirect can resume it;
// sessionStorage remembers which one is this tab's. Cleared on success, exit and expiry.
const LINK_PREFIX = "minty_link:", TAB_KEY = "minty_link_tab";
const OLD_LINK_KEYS = ["plaid_link_token", "plaid_link_owner", "plaid_link_account", "plaid_link_update_item"];
const linkStore = {
  save(e) { try { localStorage.setItem(LINK_PREFIX + e.id, JSON.stringify(e)); sessionStorage.setItem(TAB_KEY, e.id); } catch {} },
  drop(id) {
    try { localStorage.removeItem(LINK_PREFIX + id); if (sessionStorage.getItem(TAB_KEY) === id) sessionStorage.removeItem(TAB_KEY); } catch {}
  },
  all() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(LINK_PREFIX)) continue;
        try { out.push(JSON.parse(localStorage.getItem(k))); } catch { out.push({ id: k.slice(LINK_PREFIX.length), expires: "" }); }
      }
    } catch {}
    return out;
  },
  /** Drops expired entries and the pre-session keys; returns this tab's session, else the newest. */
  resume() {
    try { OLD_LINK_KEYS.forEach(k => localStorage.removeItem(k)); } catch {}
    const live = linkStore.all().filter(e => {
      if (e && Date.parse(e.expires) > Date.now()) return true;
      if (e) linkStore.drop(e.id);
      return false;
    });
    let mine = null;
    try { mine = sessionStorage.getItem(TAB_KEY); } catch {}
    return live.find(e => e.id === mine) || live.sort((a, b) => b.expires.localeCompare(a.expires))[0] || null;
  },
};
/** Link was closed without finishing: the reserved slot goes back (or a reconnect's cooldown ends). */
function cancelSession(entry) {
  linkStore.drop(entry.id);
  fetch("/link/cancel", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: entry.id }) }).catch(() => {});
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const colorOf = k => { const i = USERS.findIndex(u => u.key === k); return i < 0 ? "var(--accent)" : `var(--u${i % 6})`; };

async function loadUsers() {
  try { const r = await fetch("/users"); if (r.ok) USERS = await r.json(); } catch {}
  owner = USERS[0]?.key ?? null;
  renderOwners();
}

// With several people, every list below shows only the person picked under "Whose account?".
const many = () => USERS.length > 1;
const mine = list => (many() ? list.filter(x => x.owner === owner) : list);
const ownerLabel = k => USERS.find(u => u.key === k)?.label ?? k;
let reconnectItems = [], statementList = [], investmentList = [], connectedItems = [], connectedAccounts = [], connectedLoaded = false;
let renaming = null;                                     // the account being renamed in the Connected list
function renderLists() { renderConnected(); renderReconnect(); renderStatements(); renderInvestments(); }

// The banks and accounts already linked for the person picked.
const HEALTH_SHORT = { ok: "Up to date", downloading: "Downloading its history", expiring: "Consent ends soon: reconnect",
  stalled: "Not syncing lately", reconnect: "Needs you to sign in again", broken: "Stopped: link it again", stranded: "Its Plaid keys are missing" };
async function loadConnected() {
  try {
    const [i, a] = await Promise.all([fetch("/items"), fetch("/accounts?view=all")]);
    if (i.ok) connectedItems = await i.json();
    if (a.ok) connectedAccounts = await a.json();
  } catch {}
  connectedLoaded = true;
  renderConnected();
}
function renderConnected() {
  const box = document.getElementById("connected");
  if (!connectedLoaded) return;
  const items = mine(connectedItems);
  const who = many() ? ownerLabel(owner) : null;
  box.hidden = false;
  if (!items.length) {
    box.innerHTML = `<div class="title">${who ? `Connected for ${esc(who)}` : "Connected"}</div><div class="line"><span class="why">Nothing linked yet${who ? ` for ${esc(who)}` : ""}.</span></div>`;
    return;
  }
  box.innerHTML = `<div class="title">${who ? `Connected for ${esc(who)}` : "Connected"} · ${items.length} bank${items.length === 1 ? "" : "s"}</div>` + items.map(i => {
    const accts = connectedAccounts.filter(a => a.item_id === i.id);
    const state = i.health?.state ?? "ok";
    return `<div class="line"><span>${esc(i.institution_name || "Bank")}` +
      `<span class="why${state === "ok" ? " on" : ""}">${esc(HEALTH_SHORT[state] ?? state)}</span>` +
      `</span></div>` +
      accts.map(a => renaming === a.id
        ? `<form class="acct rename" data-rename-form="${a.id}"><input name="name" maxlength="60" value="${esc(a.name || "")}" aria-label="New name for ${esc(a.name || "this account")}">` +
          `<button type="submit">Save</button><button type="button" data-rename-cancel>Cancel</button>` +
          `<span class="why">Plaid calls it ${esc(a.plaid_name || "—")}${a.display_name ? `. <button type="button" class="linkish" data-rename-reset="${a.id}">Use Plaid's name</button>` : ""}</span></form>`
        : `<div class="acct"><span>${esc(a.name || "Account")}${a.mask ? ` ••${esc(a.mask)}` : ""}${a.in_retirement ? " (EGG)" : ""}</span>` +
          `<button type="button" class="linkish" data-rename="${a.id}">Rename</button></div>`).join("");
  }).join("");
}

// Renaming an account (any account, any person): the name shows everywhere in Minty; Plaid's own
// name is kept for recognising cards, and a sync never overwrites the new one.
const connectedBox = document.getElementById("connected");
connectedBox.addEventListener("click", async e => {
  const r = e.target.closest("[data-rename]");
  if (r) { renaming = Number(r.dataset.rename); renderConnected(); connectedBox.querySelector("[data-rename-form] input")?.select(); return; }
  if (e.target.closest("[data-rename-cancel]")) { renaming = null; return renderConnected(); }
  const reset = e.target.closest("[data-rename-reset]");
  if (reset) { await saveName(Number(reset.dataset.renameReset), null); }
});
connectedBox.addEventListener("submit", async e => {
  const f = e.target.closest("[data-rename-form]");
  if (!f) return;
  e.preventDefault();
  await saveName(Number(f.dataset.renameForm), f.elements.name.value);
});
async function saveName(id, name) {
  try {
    const res = await fetch(`/accounts/${id}/name`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    if (!res.ok) throw new Error(await why(res));
    renaming = null;
    setStatus(name ? "Renamed. The new name shows everywhere in Minty." : "Back to Plaid's name.", "ok");
    loadConnected();
  } catch (err) { setStatus("Couldn't rename: " + err.message, "err"); }
}

function renderOwners() {
  // One person: no choice to make, so hide the question (links go to that person).
  const single = USERS.length < 2;
  document.getElementById("whoLabel").hidden = single;
  document.getElementById("owners").hidden = single;
  document.getElementById("owners").innerHTML = USERS.map(u =>
    `<button class="owner" data-owner="${esc(u.key)}" aria-pressed="${u.key === owner}">` +
    `<span class="dot" style="background:${colorOf(u.key)}"></span>${esc(u.label)}</button>`).join("");
  // Can't link for someone whose Plaid keys aren't set yet — say so instead of failing at Plaid.
  const u = USERS.find(x => x.key === owner);
  const ready = !!u && u.slots.some(s => s.configured);
  connectBtn.disabled = !ready;
  const retire = document.getElementById("connectRetirement");
  if (retire) retire.disabled = !ready;                // the same keys and slots as a bank
  if (u && !ready) {
    statusEl.className = "status err";
    statusEl.innerHTML = `Plaid keys for ${esc(u.label)} aren't set yet. See <a href="/add-user">Add user</a>.`;
  } else if (statusEl.querySelector("a[href='/add-user']")) {
    setStatus("");
  }
}

document.getElementById("owners").addEventListener("click", e => {
  const b = e.target.closest(".owner");
  if (!b) return;
  owner = b.dataset.owner;
  renderOwners(); renderCapacity(); renderLists();
});

// Banks that need you to sign in again, or whose consent through Plaid ends soon (the dashboard's
// "Reconnect" links here): repair them with Link update mode.
async function loadReconnect() {
  try {
    const r = await fetch("/items");
    if (r.ok) reconnectItems = (await r.json()).filter(i => i.health?.action === "reconnect" || i.status === "login_required");
  } catch {}
  // Arriving from the dashboard's Reconnect link: show the person whose bank it is.
  if (location.hash === "#reconnect" && many() && !mine(reconnectItems).length && reconnectItems.length) {
    owner = reconnectItems[0].owner;
    renderOwners(); renderCapacity(); renderLists();
  }
  renderReconnect();
}
function renderReconnect() {
  const box = document.getElementById("reconnect");
  const items = mine(reconnectItems);
  box.hidden = !items.length;
  box.innerHTML = items.length ? `<div class="title">Needs you to sign in again</div>` + items.map(i =>
    `<div class="line"><span>${esc(i.institution_name || "Bank")}` +
    `${i.health?.detail ? `<span class="why">${esc(i.health.detail)}</span>` : ""}</span>` +
    `<button type="button" data-reconnect="${i.id}">Reconnect</button></div>`).join("") : "";
  if (items.length && location.hash === "#reconnect") box.scrollIntoView({ block: "center" });
}

document.getElementById("reconnect").addEventListener("click", async e => {
  const b = e.target.closest("button[data-reconnect]");
  if (!b) return;
  b.disabled = true;
  setStatus("Preparing…");
  try {
    const itemId = Number(b.dataset.reconnect);
    const res = await fetch("/link/token/update", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_id: itemId }),
    });
    if (!res.ok) throw new Error(await why(res));
    const { link_token, session_id, expires_at } = await res.json();
    const entry = { id: session_id, token: link_token, mode: "update", item: itemId, expires: expires_at };
    linkStore.save(entry);
    openLink(entry, null);
  } catch (err) {
    setStatus("Couldn't start reconnect: " + err.message, "err");
    b.disabled = false;
  }
});

async function loadCapacity() {
  try {
    const r = await fetch("/capacity");
    if (r.ok) { capacity = await r.json(); renderCapacity(); }
  } catch {}
}

function renderCapacity() {
  const box = document.getElementById("cap");
  if (!capacity || !capacity[owner]) { box.hidden = true; return; }
  const slots = capacity[owner];
  const hasKeys = s => s.configured !== false;
  // The next link goes to the first slot with keys that's under the cap (the server's overflow logic).
  const taken = s => s.used + (s.reserved || 0);                // banks + links in progress
  const active = slots.find(s => hasKeys(s) && taken(s) < s.cap);
  const shown = slots.filter(s => hasKeys(s) || s.used > 0);   // slots in use, or holding banks
  const idle = slots.filter(s => !hasKeys(s) && s.used === 0).map(s => s.slot);
  box.hidden = false;
  box.style.setProperty("--c", colorOf(owner));
  box.innerHTML = shown.map(s => {
    const pct = Math.min(100, Math.round((s.used / s.cap) * 100));
    const isActive = active && s.account === active.account;
    const label = !hasKeys(s) ? `${esc(s.slot)} · no keys, ${s.used} bank(s) can't sync`
      : `${esc(s.slot)}${isActive ? " · next link" : ""}${s.reserved ? ` · ${s.reserved} being linked` : ""}`;
    return `<div class="line"${hasKeys(s) ? "" : ' style="color:var(--err)"'}>
      <span class="${isActive ? "active" : ""}">${label}</span>
      <span class="bar"><span class="fill" style="width:${pct}%"></span></span>
      <b>${s.used}/${s.cap}</b>
    </div>`;
  }).join("")
    + (idle.length ? `<div class="line idle">${esc(idle.join(", "))}: no keys yet (add them to use ${idle.length === 1 ? "this Plaid account" : "these Plaid accounts"})</div>` : "")
    + (active ? "" : `<div class="line" style="color:var(--err);margin-top:8px">${idle.length
        ? `Every Plaid account with keys is full. Add keys for ${esc(idle[0])} to link more.`
        : "All Plaid trial accounts are full. Add another slot to PLAID_SLOTS (with its keys) or upgrade Plaid."}</div>`);
}

// Statement details for Bills (docs/bills.md): per bank, ask it through Plaid Link (update mode,
// Liabilities consent; the same connection, no new Trial slot), or turn them off.
const STATEMENT_STATE = {
  off: "Off",
  pending: "On: the first statement details arrive within about ten minutes.",
  ready: "On",
  consent_required: "The bank needs your consent again: turn it on again.",
  unsupported: "This bank doesn't share statement details through Plaid.",
  error: "Couldn't fetch the details; Minty retries every hour.",
};
async function loadStatements() {
  try { const r = await fetch("/statements"); if (r.ok) statementList = await r.json(); } catch {}
  renderStatements();
}
function renderStatements() {
  const box = document.getElementById("statements");
  const banks = mine(statementList);
  box.hidden = !banks.length;
  box.innerHTML = banks.length ? `<div class="title">Statement details (for Bills)</div>` + banks.map(b => {
    const on = b.statements !== "off";
    const action = !on || b.statements === "consent_required"
      ? `<button type="button" data-statements-on="${b.item_id}">Turn on</button>`
      : `<button type="button" data-statements-off="${b.item_id}">Turn off</button>`;
    return `<div class="line"><span>${esc(b.bank || "Bank")}` +
      `<span class="why${b.statements === "ready" || b.statements === "pending" ? " on" : ""}">${esc(STATEMENT_STATE[b.statements] ?? b.statements)}</span></span>${action}</div>`;
  }).join("") : "";
  if (banks.length && location.hash === "#statements") box.scrollIntoView({ block: "center" });
}

document.getElementById("statements").addEventListener("click", async e => {
  const on = e.target.closest("button[data-statements-on]"), off = e.target.closest("button[data-statements-off]");
  if (!on && !off) return;
  (on || off).disabled = true;
  try {
    if (off) {
      const res = await fetch("/statements/off", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: Number(off.dataset.statementsOff) }) });
      if (!res.ok) throw new Error(await why(res));
      setStatus("Statement details are off for that bank. The statements already saved stay in Bills.", "ok");
      return loadStatements();
    }
    setStatus("Preparing…");
    const itemId = Number(on.dataset.statementsOn);
    const res = await fetch("/link/token/statements", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_id: itemId }) });
    if (!res.ok) throw new Error(await why(res));
    const { link_token, session_id, expires_at } = await res.json();
    const entry = { id: session_id, token: link_token, mode: "statements", item: itemId, expires: expires_at };
    linkStore.save(entry);                               // kept across a bank's OAuth redirect
    openLink(entry, null);
  } catch (err) {
    setStatus("Couldn't change statement details: " + err.message, "err");
    (on || off).disabled = false;
  }
});

// Investment accounts for EGG (docs/cfa.md §3): per bank, ask for Investments through Plaid Link
// (update mode: the same connection, no new Trial slot), or turn it off. Keep every linked bank
// visible: a bank linked for Transactions may have no accounts until Investments is authorized.
const INVESTMENT_STATE = {
  off: "Off",
  pending: "On: the accounts arrive within about ten minutes.",
  ready: "On",
  consent_required: "The bank needs your consent again: add them again.",
  unsupported: "This bank doesn't share investment accounts through Plaid.",
  error: "Couldn't fetch them; Minty retries every hour.",
};
async function loadInvestments() {
  try { const r = await fetch("/investments"); if (r.ok) investmentList = await r.json(); } catch {}
  renderInvestments();
}
function renderInvestments() {
  const box = document.getElementById("investments");
  const banks = mine(investmentList);
  box.hidden = !banks.length;
  box.innerHTML = banks.length ? `<div class="title">Investment accounts (for EGG)</div>` + banks.map(b => {
    const on = b.investments !== "off";
    const action = b.products === "investments" ? ""
      : !on || b.investments === "consent_required"
      ? `<button type="button" data-investments-on="${b.item_id}">Add</button>`
      : `<button type="button" data-investments-off="${b.item_id}">Turn off</button>`;
    return `<div class="line"><span>${esc(b.bank || "Bank")}` +
      `<span class="why${b.investments === "ready" || b.investments === "pending" ? " on" : ""}">${esc(INVESTMENT_STATE[b.investments] ?? b.investments)}</span></span>${action}</div>`;
  }).join("") : "";
  if (banks.length && location.hash === "#investments") box.scrollIntoView({ block: "center" });
}

document.getElementById("investments").addEventListener("click", async e => {
  const on = e.target.closest("button[data-investments-on]"), off = e.target.closest("button[data-investments-off]");
  if (!on && !off) return;
  (on || off).disabled = true;
  try {
    if (off) {
      const res = await fetch("/investments/off", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: Number(off.dataset.investmentsOff) }) });
      if (!res.ok) throw new Error(await why(res));
      setStatus("That bank's investment accounts won't update any more. What was saved stays.", "ok");
      return loadInvestments();
    }
    setStatus("Preparing…");
    const itemId = Number(on.dataset.investmentsOn);
    const res = await fetch("/link/token/investments", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_id: itemId }) });
    if (!res.ok) throw new Error(await why(res));
    const { link_token, session_id, expires_at } = await res.json();
    const entry = { id: session_id, token: link_token, mode: "investments", item: itemId, expires: expires_at };
    linkStore.save(entry);
    openLink(entry, null);
  } catch (err) {
    setStatus("Couldn't add the investment accounts: " + err.message, "err");
    (on || off).disabled = false;
  }
});

document.getElementById("connectRetirement").addEventListener("click", async e => {
  const btn = e.currentTarget;
  btn.disabled = true;
  setStatus("Preparing…");
  try {
    const res = await fetch("/link/token", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner, kind: "investments" }) });
    if (!res.ok) throw new Error(await why(res));
    const { link_token, session_id, expires_at } = await res.json();
    const entry = { id: session_id, token: link_token, mode: "link-investments", expires: expires_at };
    linkStore.save(entry);
    openLink(entry, null);
  } catch (err) {
    setStatus("Couldn't start Link: " + err.message, "err");
    btn.disabled = false;
  }
});

// OAuth return: resume with the SAME link_token and session saved before the redirect.
const params = new URLSearchParams(window.location.search);
const resumable = linkStore.resume();                    // also clears expired sessions
if (params.get("oauth_state_id")) {
  if (resumable) openLink(resumable, window.location.href);
  else setStatus("Could not resume the connection (it may have taken longer than 30 minutes). Please start again.", "err");
}

connectBtn.addEventListener("click", async () => {
  connectBtn.disabled = true;
  setStatus("Preparing…");
  try {
    const res = await fetch("/link/token", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner }),
    });
    if (!res.ok) throw new Error(await why(res));
    const { link_token, session_id, expires_at } = await res.json();
    // kept across a possible OAuth redirect; the session holds a slot until it's used or cancelled
    const entry = { id: session_id, token: link_token, mode: "link", expires: expires_at };
    linkStore.save(entry);
    openLink(entry, null);
  } catch (e) {
    setStatus("Couldn't start Link: " + e.message, "err");
    connectBtn.disabled = false;
  }
});

// entry.mode "update" = reconnect: Plaid repairs the existing Item; nothing to exchange.
function openLink(entry, receivedRedirectUri) {
  let finished = false;
  const handler = Plaid.create({
    token: entry.token,
    receivedRedirectUri,
    onSuccess: async (public_token, metadata) => {
      finished = true;
      if (entry.mode === "statements") {
        // Plaid must confirm the bank's consent before Minty fetches anything (src/routes/bills.ts).
        setStatus("Checking the bank's consent with Plaid…");
        try {
          const res = await fetch("/link/statements/complete", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: entry.id }),
          });
          linkStore.drop(entry.id);
          if (!res.ok) throw new Error(await why(res));
          setStatus("Statement details are on. The first ones arrive within about ten minutes; see Bills on the dashboard.", "ok");
        } catch (err) {
          setStatus("Statement details aren't on yet: " + err.message, "err");
        }
        loadStatements();
        return;
      }
      if (entry.mode === "investments") {
        // Plaid must confirm the bank's consent before Minty fetches anything (src/routes/investments.ts).
        setStatus("Checking the bank's consent with Plaid…");
        try {
          const res = await fetch("/link/investments/complete", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: entry.id }),
          });
          linkStore.drop(entry.id);
          if (!res.ok) throw new Error(await why(res));
          setStatus("Investment accounts are on. They arrive within about ten minutes, in EGG on the dashboard.", "ok");
        } catch (err) {
          setStatus("The investment accounts aren't on yet: " + err.message, "err");
        }
        loadInvestments();
        return;
      }
      if (entry.mode === "update") {
        linkStore.drop(entry.id);
        const updateItemId = entry.item;
        setStatus("Reconnected. Checking the connection with Plaid…");
        try {
          // Plaid's view of the connection now, so the dashboard's warning clears right away.
          const res = await fetch("/link/reconnected", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ item_id: updateItemId }),
          });
          if (!res.ok) throw new Error(await why(res));
          const { health } = await res.json();
          if (health.action === "reconnect" || health.action === "relink") {
            setStatus(`${health.message} ${health.detail ?? ""}`.trim(), "err");
          } else {
            setStatus("Reconnected. New transactions arrive with the next hourly sync.", "ok");
          }
        } catch {
          setStatus("Reconnected. It will refresh on the next hourly sync.", "ok");
        }
        loadReconnect();
        return;
      }
      setStatus("Linking and pulling transactions…");
      try {
        const res = await fetch("/link/exchange", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: entry.id, public_token, institution_name: metadata?.institution?.name ?? null }),
        });
        linkStore.drop(entry.id);                        // used (or refused): a public token works once
        if (!res.ok) throw new Error(await why(res));
        const data = await res.json();
        setStatus(entry.mode === "link-investments"
          ? "Connected. Its investment accounts arrive within about ten minutes, in EGG on the dashboard (not in the feed)."
          : data.status === "good" ? "Connected. Transactions are syncing." : "Connected (status: " + data.status + ").", "ok");
        loadCapacity();
        loadConnected();
        loadInvestments();
        connectBtn.disabled = false;
        document.getElementById("connectRetirement").disabled = false;
      } catch (e) {
        setStatus("Exchange failed: " + e.message, "err");
        connectBtn.disabled = false;
        document.getElementById("connectRetirement").disabled = false;
      }
    },
    onExit: (err) => {
      if (!finished) cancelSession(entry);
      if (err) setStatus("Link closed: " + (err.error_message || err.error_code || "cancelled"), "err");
      else setStatus("");
      connectBtn.disabled = false;
      document.getElementById("connectRetirement").disabled = false;
      loadReconnect();
      loadStatements();
      loadInvestments();
    },
  });
  handler.open();
}

// Light/dark toggle (shares the "minty-theme" preference with the dashboard).
(function themeToggle() {
  const root = document.documentElement, btn = document.getElementById("themeToggle");
  const apply = t => {
    root.dataset.theme = t;
    const label = t === "dark" ? "Switch to light mode" : "Switch to dark mode";
    btn.setAttribute("aria-label", label); btn.title = label;
  };
  apply(root.dataset.theme);
  btn.addEventListener("click", () => {
    const t = root.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem("minty-theme", t); apply(t);
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", e => {
    if (!localStorage.getItem("minty-theme")) apply(e.matches ? "dark" : "light");
  });
})();

loadUsers().then(() => { loadCapacity(); loadConnected(); loadReconnect(); loadStatements(); loadInvestments(); });
