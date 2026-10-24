// ABC ("All but coupon clipping") in a popup on the dashboard, like Inkling's dialogs: a native
// <dialog> opened with showModal(), closed by its × button, Esc or a click outside, and opened
// straight away by /?abc. Data comes from GET /benefits (src/routes/benefits.ts).
(function () {
  const dialog = document.getElementById("abc");
  if (!dialog) return;
  const main = document.getElementById("abcMain");
  const yearSel = document.getElementById("abcYear");

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = c => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = d => `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
  const dayYear = d => `${day(d)}, ${d.slice(0, 4)}`;
  const PERIOD = { monthly: "each month", quarterly: "each quarter", semiannual: "each half-year", annual: "each year", every_4_years: "every 4 years" };
  const STATUS = { used: "Used", partial: "Partly used", pending: "Charged, credit pending", locked: "Not unlocked yet",
                   open: "Open", missed: "Missed", upcoming: "Not started" };
  let users = [];
  let data = null;
  let year = null;
  const collapsed = new Set();                    // cards folded by the viewer, kept across reloads

  async function load() {
    try {
      const [u, r] = await Promise.all([fetch("/users"), fetch("/benefits" + (year ? `?year=${year}` : ""))]);
      if (u.ok) users = await u.json();
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.status);
      data = await r.json();
    } catch (e) {
      main.innerHTML = `<div class="abc-msg abc-err">Couldn't load your credits: ${esc(e.message)}</div>`;
      return;
    }
    year = data.year;
    const thisYear = Number(data.today.slice(0, 4));
    yearSel.innerHTML = [thisYear, thisYear - 1, thisYear - 2].map(y => `<option value="${y}" ${y === year ? "selected" : ""}>${y}</option>`).join("");
    yearSel.hidden = false;
    render();
  }

  const who = c => users.length > 1 ? ` · ${esc(users.find(u => u.key === c.owner)?.label ?? c.owner)}` : "";
  const cardTitle = c => `${esc(c.name || "Card")}${c.mask ? ` ••${esc(c.mask)}` : ""}`;

  function render() {
    const openSettings=new Set([...main.querySelectorAll("details[open]")].map(el=>el.querySelector(":scope > summary")?.textContent));
    const d = data, t = d.totals;
    const tracked = d.cards.filter(c => c.product && !c.hidden);
    const hidden = d.cards.filter(c => c.hidden);
    const others = d.cards.filter(c => !c.product && !c.hidden);
    const past = d.year < Number(d.today.slice(0, 4));
    let html = `
      <div class="abc-tiles">
        <div class="abc-tile used"><div class="k">Used in ${d.year}</div><div class="v">${money(t.used_cents)}</div><div class="of">of ${money(t.available_cents)} available</div></div>
        <div class="abc-tile open"><div class="k">${past ? "Left open" : "Open now"}</div><div class="v">${money(t.open_now_cents)}</div><div class="of">in current periods</div></div>
        <div class="abc-tile pending"><div class="k">Credit pending</div><div class="v">${money(t.pending_cents)}</div><div class="of">charged, not credited yet</div></div>
        <div class="abc-tile missed"><div class="k">Missed</div><div class="v">${money(t.missed_cents)}</div><div class="of">in periods that ended</div></div>
      </div>
      <div class="abc-legend">
        <span><span class="sq used"></span>used</span><span><span class="sq partial"></span>partly / pending</span>
        <span><span class="sq missed"></span>missed</span><span><span class="sq open"></span>open now</span><span><span class="sq upcoming"></span>not started</span>
      </div>`;

    html += `<details class="abc-settings"><summary>Credits I use &middot; applies to every card of a product</summary><p>Turn off benefits you do not use. They leave tracker totals and reminder candidates on every matching card, for both players. Transactions and saved usage marks are preserved.</p>${d.products.filter(p=>d.cards.some(c=>c.product?.id===p.id)).map(p=>`<details><summary>${esc(p.name)}</summary>${(p.benefits||[]).map(b=>`<label class="abc-product-credit"><input type="checkbox" data-product-credit="${esc(p.id)}" data-benefit-id="${esc(b.id)}" ${b.enabled?'checked':''}>${esc(b.name)}</label>`).join('')}</details>`).join('')}</details>`;
    const soon = d.ending_soon.slice(0, 8);
    if (soon.length && !past) {
      html += `<h3>Use before it resets</h3><div class="abc-list abc-soon">` + soon.map(e => `<div class="row">
        <span class="amt">${money(e.left_cents)}</span>
        <span class="what">${esc(e.benefit)} <span class="abc-muted" title="${esc(e.card || "")}">${e.mask ? "••" + esc(e.mask) : esc(e.card || "")}</span></span>
        <span class="when">by ${day(e.ends)}</span></div>`).join("") + `</div>`;
    }

    if (!tracked.length) html += `<div class="abc-msg">None of your cards has credits Minty tracks yet. If one does, pick it under “Other cards” below.</div>`;
    for (const c of tracked) html += cardHTML(c);

    if (others.length) {
      html += `<h3>Other cards</h3><div class="abc-list">` + others.map(c => `<div class="row">
        <span>${cardTitle(c)} <span class="abc-muted">· ${esc(c.bank || "")}${who(c)}</span></span>
        <span><select data-product="${c.account_id}" aria-label="Which card is this?">
          <option value="">No tracked credits</option>
          ${d.products.map(p => `<option value="${esc(p.id)}">It's a ${esc(p.name)}</option>`).join("")}
        </select> <button type="button" class="abc-link" data-hide="${c.account_id}">Hide</button></span></div>`).join("") + `</div>`;
    }
    if (hidden.length) {
      html += `<h3>Hidden cards</h3><div class="abc-list">` + hidden.map(c => `<div class="row">
        <span>${cardTitle(c)} <span class="abc-muted">· ${esc(c.bank || "")}</span></span>
        <button type="button" class="abc-link" data-unhide="${c.account_id}">Show again</button></div>`).join("") + `</div>`;
    }

    html += `<div class="abc-foot">Original catalog checked ${esc(d.checked)}; additional products checked 2026-10-23 (issuer sources linked for each benefit). Historical totals use catalog terms, which may differ from earlier offers.
      Credits count in the period of the purchase they paid back. For credits marked <span class="abc-guess" aria-hidden="true">*</span>, no statement credit
      has posted yet, so Minty matches it by a best guess at its wording. Not tracked:<ul>${d.not_tracked.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
    main.innerHTML = html;
    for(const el of main.querySelectorAll("details"))if(openSettings.has(el.querySelector(":scope > summary")?.textContent))el.open=true;
  }

  function cardHTML(c) {
    const t = c.totals;
    const productPicker = `<select data-product="${c.account_id}" aria-label="Card product">
        <option value="auto" ${c.product_source !== "chosen" ? "selected" : ""}>${c.product_source === "chosen" ? "Recognise automatically" : esc(c.product.name) + " (recognised)"}</option>
        ${data.products.map(p => `<option value="${esc(p.id)}" ${c.product_source === "chosen" && c.product.id === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
        <option value="none">No tracked credits</option></select>`;
    const yearPicker = c.card_year ? `<label>Card year starts <select data-month="${c.account_id}" aria-label="Card year starts">
        ${MON.map((m, i) => `<option value="${i + 1}" ${c.card_year.month === i + 1 ? "selected" : ""}>${m}</option>`).join("")}</select></label>
        ${c.card_year.source === "annual_fee" ? `<span title="From the first annual fee on the card">(from the annual fee)</span>` : ""}` : "";
    const pct = t.available_cents ? Math.round(100 * t.used_cents / t.available_cents) : 0;
    return `<details class="abc-card" data-card="${c.account_id}" ${collapsed.has(c.account_id) ? "" : "open"}>
      <summary class="head">
        <span class="title">${cardTitle(c)}</span>
        <span class="meta">${esc(c.product.name)}${who(c)} · ${money(c.product.fee_cents)} fee</span>
        <span class="sum"><b>${money(t.used_cents)}</b> of ${money(t.available_cents)} used (${pct}%)${t.open_now_cents ? ` · <b class="open">${money(t.open_now_cents)}</b> open` : ""}</span>
      </summary>
      ${c.benefits.map(b => benefitHTML(c, b)).join("")}

      <details class="abc-settings"><summary>Card settings</summary>
        <div class="tools">${productPicker} ${yearPicker} <button type="button" class="abc-link" data-hide="${c.account_id}">Hide this card</button></div>
      </details>
    </details>`;
  }

  function benefitHTML(c, b) {
    const chips = (b.enroll ? `<span class="chip warn" title="Enroll in the issuer's app or site, or the credit never posts">enroll</span>` : "")
      + (b.how === "outside" ? `<span class="chip" title="Minty can't see this one on a statement: tick it when you've used it">tick when used</span>` : "");
    const guess = !b.label_seen && b.how === "on_card"
      ? `<span class="abc-guess" title="No statement credit has posted yet: Minty matches it by a best guess at its wording">*</span>` : "";
    const left = `<div><div class="name">${esc(b.name)}${guess} · ${money(b.amount_cents)} ${PERIOD[b.period]}${chips}</div>
      <div class="note">${esc(b.note)} ${b.source?`<a class="src" href="${esc(b.source)}" target="_blank" rel="noopener">source</a>`:"Manually configured"}</div></div>`;

    if (b.once) {
      const o = b.once;
      const text = o.status === "used" ? `<span class="st used">Used</span> ${dayYear(o.last_used)} · next from ${dayYear(o.next_from)}`
        : o.last_used ? `<span class="st open">Available again</span> since ${dayYear(o.next_from)}`
        : `<span class="st open">No credit seen</span>${o.data_since ? ` since ${dayYear(o.data_since)} (Minty's history for this card)` : ""}`;
      return `<div class="ben">${left}<div class="now">${text}</div></div>`;
    }

    const p = b.current;
    let now = "";
    if (p) {
      const pct = Math.min(100, Math.round(100 * p.used_cents / p.cap_cents));
      now = `<span class="st ${p.status}">${STATUS[p.status]}</span> · ${money(p.used_cents)} of ${money(p.cap_cents)} · ${p.label}, ends ${day(p.end)}`;
      if (p.pending_cents) now += ` · ${money(p.pending_cents)} charged, waiting for the credit`;
      if (b.unlock && p.status === "locked") now += ` · spent ${money(b.unlock.spent_cents)} of ${money(b.unlock.needed_cents)} needed`;
      now += `<div class="bar"><span style="width:${pct}%"></span></div>`;
    } else {
      now = `<span class="st upcoming">No period this year</span>`;
    }
    const unpaid = b.periods.filter(x => x.status === "missed" && x.unpaid_cents);
    if (unpaid.length) now += `<div class="note abc-err">Charged in ${unpaid.length} period${unpaid.length > 1 ? "s" : ""} with no credit back (${unpaid.map(x => x.label).join(", ")}): is it enrolled?</div>`;

    const squares = b.periods.map(x => {
      const title = `${x.label}: ${STATUS[x.status]}, ${money(x.used_cents)} of ${money(x.cap_cents)}` +
        (x.unpaid_cents ? `, ${money(x.unpaid_cents)} charged with no credit` : "") + (x.in_year ? "" : ` (counted in ${x.start.slice(0, 4)})`);
      const cls = `sq ${x.status}${x.in_year ? "" : " out"}`;
      if (b.how === "outside" && x.status !== "upcoming") {
        return `<button type="button" class="${cls}" role="checkbox" aria-checked="${!!x.marked}" title="${esc(title)} — click to ${x.marked ? "untick" : "tick as used"}"
          data-mark="${c.account_id}|${esc(b.id)}|${x.start}|${x.marked ? 0 : 1}"></button>`;
      }
      return `<span class="${cls}" title="${esc(title)}"></span>`;
    }).join("");
    // one period this year: the bar says it all, unless it's ticked by hand
    const showSquares = b.periods.length > 1 || b.how === "outside";
    return `<div class="ben">${left}<div><div class="now">${now}</div>${showSquares ? `<div class="squares" aria-label="${esc(b.name)} by period">${squares}</div>` : ""}</div></div>`;
  }

  async function put(path, body) {
    const r = await fetch(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) { alert("Couldn't save: " + ((await r.json().catch(() => ({}))).detail || r.status)); return false; }
    return true;
  }

  main.addEventListener("change", async e => {
    const s = e.target;
    if (s.dataset.productCredit) {
      s.disabled=true;
      try { if(await put('/benefits/preferences',{product_id:s.dataset.productCredit,benefit_id:s.dataset.benefitId,enabled:s.checked}))await load(); else s.checked=!s.checked; }
      finally {s.disabled=false;}
    } else if (s.dataset.product) {
      // "auto" / "" = recognise automatically (null); "none" = no tracked credits; else a product id
      const v = s.value;
      if (await put(`/benefits/cards/${s.dataset.product}`, { product_id: v === "auto" || v === "" ? null : v })) load();
    } else if (s.dataset.month) {
      if (await put(`/benefits/cards/${s.dataset.month}`, { anniversary_month: Number(s.value) })) load();
    }
  });
  main.addEventListener("click", async e => {
    const b = e.target.closest("[data-mark],[data-hide],[data-unhide]");
    if (!b) return;
    if (b.dataset.mark) {
      const [account_id, benefit_id, period_start, used] = b.dataset.mark.split("|");
      b.disabled = true;
      if (await put("/benefits/marks", { account_id: Number(account_id), benefit_id, period_start, used: used === "1" })) load();
      else b.disabled = false;
    } else if (b.dataset.hide) {
      if (await put(`/benefits/cards/${b.dataset.hide}`, { hidden: true })) load();
    } else if (b.dataset.unhide) {
      if (await put(`/benefits/cards/${b.dataset.unhide}`, { hidden: false })) load();
    }
  });
  yearSel.addEventListener("change", e => { year = Number(e.target.value); load(); });
  // remember folded cards ("toggle" doesn't bubble, so listen in the capture phase)
  main.addEventListener("toggle", e => {
    const card = e.target.closest?.("details.abc-card");
    if (card && e.target === card) card.open ? collapsed.delete(Number(card.dataset.card)) : collapsed.add(Number(card.dataset.card));
  }, true);

  function open() {
    if (!dialog.open) dialog.showModal();
    dialog.focus();
    if (!data) main.innerHTML = `<div class="abc-msg">Loading…</div>`;
    load();                                        // fresh numbers every time it opens
  }
  // Like Inkling: a click on the backdrop (outside the box) closes it; Esc closes it natively.
  dialog.addEventListener("click", e => { if (e.target === dialog) dialog.close(); });
  for (const b of document.querySelectorAll("[data-open-abc]")) b.addEventListener("click", open);
  if (new URLSearchParams(location.search).has("abc")) queueMicrotask(open);
})();
