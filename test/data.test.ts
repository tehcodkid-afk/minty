import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { normaliseTags } from "../src/routes/data";
import { call, getJson, loadFixture } from "./helpers";

// Read API and tag editing, against a real (local) D1.
beforeEach(loadFixture);

const ids = (rows: Array<{ id: number }>) => rows.map((r) => r.id);

describe("GET /transactions", () => {
  it("returns every row newest first, in the shape the pages expect", async () => {
    const { status, body } = await getJson("/transactions");
    expect(status).toBe(200);
    expect(ids(body)).toEqual([100, 101, 102, 200, 201]);
    expect(body[0]).toEqual({
      id: 100, owner: "me", account_id: 10, plaid_txn_id: "txn-100", amount: 84.12, currency: "USD",
      date: "2026-09-20", datetime: null, name: "WHOLE FOODS", merchant_name: "Whole Foods Market",
      category: "FOOD_AND_DRINK", pending: false, pending_txn_id: null, tags: ["groceries"],
      account_name: "Sapphire", account_mask: "9912", account_type: "credit", account_subtype: "credit card",
      item_id: 1, institution_name: "Chase", account_owner: null,
    });
    expect(body.find((t: any) => t.id === 102).amount).toBe(-2450);      // cents -> dollars, sign kept
    expect(body.find((t: any) => t.id === 101).pending).toBe(true);
    expect(body.find((t: any) => t.id === 201).tags).toEqual(["travel", "reimbursable"]);  // user order
  });

  it("filters by owner, account, dates and search", async () => {
    expect(ids((await getJson("/transactions?owner=spouse")).body)).toEqual([200, 201]);
    expect(ids((await getJson("/transactions?account_id=11")).body)).toEqual([102]);
    expect(ids((await getJson("/transactions?start=2026-09-17&end=2026-09-19")).body)).toEqual([101, 102, 200]);
    expect(ids((await getJson("/transactions?q=whole")).body)).toEqual([100]);           // case-insensitive
    expect(ids((await getJson("/transactions?q=airlines")).body)).toEqual([201]);        // merchant_name too
  });

  it("filters by one or several banks (item_id), alone or with other filters", async () => {
    expect(ids((await getJson("/transactions?item_id=1")).body)).toEqual([100, 101, 102]);   // every account at Chase
    expect(ids((await getJson("/transactions?item_id=2")).body)).toEqual([200, 201]);
    expect(ids((await getJson("/transactions?item_id=1&item_id=2")).body)).toEqual([100, 101, 102, 200, 201]);
    expect(ids((await getJson("/transactions?item_id=1&item_id=1")).body)).toEqual([100, 101, 102]);  // duplicates ok
    expect(ids((await getJson("/transactions?item_id=1&owner=spouse")).body)).toEqual([]);   // filters AND together
    expect(ids((await getJson("/transactions?item_id=1&item_id=2&q=netflix")).body)).toEqual([200]);
    expect(ids((await getJson("/transactions?item_id=1&tag=car")).body)).toEqual([101]);
    expect(ids((await getJson("/transactions?item_id=999")).body)).toEqual([]);             // unknown bank: no rows
    expect(ids((await getJson("/transactions?item_id=")).body)).toHaveLength(5);            // blank = no filter
    const rows = (await getJson("/transactions?item_id=2")).body;
    expect(rows.map((t: any) => [t.item_id, t.institution_name])).toEqual([[2, "Ally"], [2, "Ally"]]);
  });

  it("rejects malformed or too many bank filters", async () => {
    for (const bad of ["abc", "-1", "1.5", "1 OR 1=1"]) {
      const r = await getJson(`/transactions?item_id=${encodeURIComponent(bad)}`);
      expect(r.status).toBe(422);
      expect(r.body.detail).toMatch(/item_id must be an integer/);
    }
    const ids60 = (n: number, name: string, from = 1) => Array.from({ length: n }, (_, i) => `${name}=${from + i}`);
    // banks + accounts share one cap of 60
    expect((await getJson(`/transactions?${ids60(61, "item_id").join("&")}`)).status).toBe(422);
    expect((await getJson(`/transactions?${[...ids60(40, "item_id"), ...ids60(21, "account_id")].join("&")}`)).status).toBe(422);
    // the worst case still fits D1's 100 bound parameters: 60 ids + 20 tags (all) + every other filter
    const tags = Array.from({ length: 20 }, (_, i) => `tag=t${i}`);
    const worst = [...ids60(30, "item_id"), ...ids60(30, "account_id"), ...tags, "tag_mode=all", "owner=me",
                   "start=2026-01-01", "end=2026-12-31", "q=x", "limit=10"].join("&");
    expect((await getJson(`/transactions?${worst}`)).status).toBe(200);
  });

  it("filters by card member (card=<account_id>:<member>), OR'd with whole accounts, AND'd with the rest", async () => {
    await env.DB.prepare("UPDATE transactions SET account_owner = 'ALEX MORGAN' WHERE id = 100").run();
    await env.DB.prepare("UPDATE transactions SET account_owner = 'A:B -1013' WHERE id = 200").run();
    const q = (s: string) => getJson(`/transactions?${s}`).then((r) => ids(r.body));
    expect(await q(`card=${encodeURIComponent("10:ALEX MORGAN")}`)).toEqual([100]);
    expect(await q("card=10:")).toEqual([101]);                                    // that card's rows without a member
    expect(await q(`card=${encodeURIComponent("10:ALEX MORGAN")}&account_id=11`)).toEqual([100, 102]);   // OR with whole accounts
    expect(await q(`card=${encodeURIComponent("10:ALEX MORGAN")}&card=10:`)).toEqual([100, 101]);
    expect(await q(`card=${encodeURIComponent("10:ALEX MORGAN")}&item_id=2`)).toEqual([]);              // AND with banks
    expect(await q(`card=${encodeURIComponent("10:ALEX MORGAN")}&q=whole`)).toEqual([100]);
    expect(await q(`card=${encodeURIComponent("20:A:B -1013")}`)).toEqual([200]);  // ":" inside a member name
    expect(await q(`card=${encodeURIComponent("10:NOBODY")}`)).toEqual([]);
    expect(await q("card=")).toHaveLength(5);                                       // blank = no filter
    for (const bad of ["abc", "10", "x:ALEX", `10:${"x".repeat(201)}`]) {
      expect((await getJson(`/transactions?card=${encodeURIComponent(bad)}`)).status).toBe(422);
    }
    const cards30 = Array.from({ length: 30 }, (_, i) => `card=${i + 1}:M`).join("&");
    expect((await getJson(`/transactions?${cards30}`)).status).toBe(200);           // 30 members = 60
    expect((await getJson(`/transactions?${cards30}&item_id=1`)).status).toBe(422);  // 61
  });

  it("lists each multi-card account's card members with counts", async () => {
    await env.DB.prepare("UPDATE transactions SET account_owner = 'SAM MORGAN -1013' WHERE id = 100").run();
    const accts = (await getJson("/accounts")).body;
    expect(accts.find((a: any) => a.id === 10).card_members).toEqual([
      { name: "SAM MORGAN -1013", count: 1 }, { name: null, count: 1 },            // named first, then "no card member"
    ]);
    expect(accts.find((a: any) => a.id === 11).card_members).toEqual([]);
    expect(accts.find((a: any) => a.id === 20).card_members).toEqual([]);
  });

  it("filters by one or several accounts (account_id), within the selected banks", async () => {
    expect(ids((await getJson("/transactions?account_id=10")).body)).toEqual([100, 101]);            // Sapphire card
    expect(ids((await getJson("/transactions?account_id=10&account_id=20")).body)).toEqual([100, 101, 200, 201]);
    expect(ids((await getJson("/transactions?account_id=11&item_id=1")).body)).toEqual([102]);       // account in bank
    expect(ids((await getJson("/transactions?account_id=20&item_id=1")).body)).toEqual([]);          // ANDs with banks
    expect(ids((await getJson("/transactions?account_id=10&account_id=10")).body)).toEqual([100, 101]);  // duplicates ok
    expect(ids((await getJson("/transactions?account_id=10&tag=car")).body)).toEqual([101]);
    expect(ids((await getJson("/transactions?account_id=")).body)).toHaveLength(5);                  // blank = no filter
    for (const bad of ["x", "-3", "2.5"]) {
      const r = await getJson(`/transactions?account_id=${bad}`);
      expect(r.status).toBe(422);
      expect(r.body.detail).toMatch(/account_id must be an integer/);
    }
  });

  it("treats user input as data, never SQL", async () => {
    const { status, body } = await getJson(`/transactions?q=${encodeURIComponent("50%'; DROP TABLE transactions; --")}`);
    expect(status).toBe(200);
    expect(body).toEqual([]);
    expect((await getJson("/transactions")).body).toHaveLength(5);
  });

  it("matches ANY of several tags by default", async () => {
    expect(ids((await getJson("/transactions?tag=groceries&tag=travel")).body)).toEqual([100, 201]);
    expect(ids((await getJson("/transactions?tag=TRAVEL")).body)).toEqual([201]);          // tags are case-insensitive
  });

  it("matches ALL tags with tag_mode=all", async () => {
    expect(ids((await getJson("/transactions?tag=travel&tag=reimbursable&tag_mode=all")).body)).toEqual([201]);
    expect(ids((await getJson("/transactions?tag=travel&tag=groceries&tag_mode=all")).body)).toEqual([]);
    expect(ids((await getJson("/transactions?tag=travel&tag=Travel&tag_mode=all")).body)).toEqual([201]);  // deduped
  });

  it("ignores blank tags", async () => {
    expect((await getJson("/transactions?tag=&tag=%20&tag_mode=all")).body).toHaveLength(5);
  });

  it.each([
    "tag_mode=some", "limit=1001", "limit=0", "limit=abc", "account_id=x", "start=2026-13-45", "start=yesterday",
    Array.from({ length: 21 }, (_, i) => `tag=t${i}`).join("&"),
  ])("rejects %s with 422", async (qs) => {
    expect((await call(`/transactions?${qs}`)).status).toBe(422);
  });

  it("pages back with before=<date>:<id>, newest first", async () => {
    const all = ids((await getJson("/transactions")).body);
    const first = (await getJson("/transactions?limit=2")).body;
    const last = first[first.length - 1];
    expect(ids((await getJson(`/transactions?limit=10&before=${last.date}:${last.id}`)).body)).toEqual(all.slice(2));
    expect((await call("/transactions?before=yesterday")).status).toBe(422);
  });

  it("honours limit", async () => {
    expect(ids((await getJson("/transactions?limit=2")).body)).toEqual([100, 101]);
  });
});

describe("items, accounts, capacity", () => {
  it("lists items without token material", async () => {
    const r = await call("/items");
    const text = await r.text();
    expect(JSON.parse(text)).toEqual([
      { id: 1, source: "plaid", owner: "me", plaid_account: "me_primary", institution_name: "Chase", status: "good", updated_at: "2026-09-01T00:00:00.000Z",
        health: expect.objectContaining({ state: "stalled", level: "warn" }) },
      { id: 2, source: "plaid", owner: "spouse", plaid_account: "spouse_primary", institution_name: "Ally", status: "good", updated_at: "2026-09-01T00:00:00.000Z",
        health: expect.objectContaining({ state: "stalled", level: "warn" }) },
    ]);
    expect(text).not.toMatch(/gAAAA|access_token/);
  });

  it("/health lists banks needing attention, most serious first, and whether sync runs", async () => {
    await env.DB.batch([
      env.DB.prepare("UPDATE items SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), txn_cursor = 'c' WHERE id = 1"),
      env.DB.prepare("UPDATE items SET status = 'login_required', last_error = 'ITEM_LOGIN_REQUIRED' WHERE id = 2"),
    ]);
    const { status, body } = await getJson("/health");
    expect(status).toBe(200);
    expect(body.sync).toEqual({ ok: true, message: "Last sync within the hour." });
    expect(body.banks).toEqual([{ id: 2, owner: "spouse", institution_name: "Ally",
      health: expect.objectContaining({ state: "reconnect", level: "error", action: "reconnect", message: "Ally needs you to sign in again." }) }]);
    await env.DB.prepare("UPDATE items SET status = 'good', updated_at = '2026-09-01T00:00:00.000Z' WHERE id = 2").run();
    await env.DB.prepare("UPDATE items SET sync_start_cursor = '' WHERE id = 1").run();
    expect((await getJson("/health")).body.banks.map((b: any) => [b.id, b.health.state])).toEqual([[2, "stalled"], [1, "downloading"]]);
  });

  it("lists accounts with dollar balances, optionally per owner", async () => {
    const all = (await getJson("/accounts")).body;
    expect(all.map((a: any) => a.id)).toEqual([11, 10, 20]);                       // owner, then name
    expect(all.find((a: any) => a.id === 10)).toMatchObject({ balance_current: 1284.55, balance_available: null });
    expect((await getJson("/accounts?owner=spouse")).body.map((a: any) => a.id)).toEqual([20]);
  });

  it("reports every slot's usage against the cap", async () => {
    expect((await getJson("/capacity")).body).toEqual({
      me: [{ account: "me_primary", slot: "primary", used: 1, reserved: 0, cap: 10, configured: true },
           { account: "me_backup", slot: "backup", used: 0, reserved: 0, cap: 10, configured: true }],
      spouse: [{ account: "spouse_primary", slot: "primary", used: 1, reserved: 0, cap: 10, configured: true },
               { account: "spouse_backup", slot: "backup", used: 0, reserved: 0, cap: 10, configured: false }],
    });
  });

  it("follows PLAID_SLOTS, one entry per slot in overflow order", async () => {
    const body = (await getJson("/capacity", { envOverrides: {
      PLAID_SLOTS: "primary,backup,extra1", PLAID_CLIENT_ID_ME_EXTRA1: "c", PLAID_SECRET_ME_EXTRA1: "s" } })).body;
    expect(body.me.map((s: any) => [s.slot, s.configured])).toEqual([["primary", true], ["backup", true], ["extra1", true]]);
    expect(body.spouse.map((s: any) => [s.slot, s.configured])).toEqual([["primary", true], ["backup", false], ["extra1", false]]);
  });
});

describe("tags", () => {
  it("normalises: trims, drops blanks, dedupes case-insensitively keeping the first", () => {
    expect(normaliseTags(["  Travel", "travel", "", "  ", "Food", "TRAVEL"])).toEqual(["Travel", "Food"]);
  });

  it("lists distinct tags", async () => {
    expect((await getJson("/tags")).body).toEqual(["car", "groceries", "reimbursable", "subscription", "travel"]);
  });

  const put = (id: number | string, body: unknown) =>
    call(`/transactions/${id}/tags`, { method: "PUT", body: typeof body === "string" ? body : JSON.stringify(body) });

  it("replaces a transaction's tags, normalised and in order", async () => {
    const r = await put(100, { tags: ["Food", "food", " ", "costco-run"] });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: 100, tags: ["Food", "costco-run"] });
    const row = (await getJson("/transactions?tag=costco-run")).body[0];
    expect(row.id).toBe(100);
    expect(row.tags).toEqual(["Food", "costco-run"]);
    expect((await getJson("/tags")).body).toContain("costco-run");
    expect((await getJson("/tags")).body).not.toContain("groceries");                  // replaced, not appended
  });

  it("clears tags with an empty list", async () => {
    expect(await (await put(201, { tags: [] })).json()).toEqual({ id: 201, tags: [] });
    expect((await getJson("/transactions?tag=travel")).body).toEqual([]);
  });

  it("404s for an unknown transaction", async () => {
    expect((await put(999, { tags: ["x"] })).status).toBe(404);
  });

  it.each([
    ["non-integer id", "abc", { tags: [] }],
    ["not JSON", 100, "{nope"],
    ["tags missing", 100, {}],
    ["tags not strings", 100, { tags: [1, 2] }],
    ["too many tags", 100, { tags: Array.from({ length: 51 }, (_, i) => `t${i}`) }],
    ["tag too long", 100, { tags: ["x".repeat(65)] }],
  ] as const)("rejects %s with 422", async (_, id, body) => {
    expect((await put(id, body)).status).toBe(422);
  });

  it("drops a transaction's tags when the transaction is deleted (e.g. Plaid 'removed')", async () => {
    await env.DB.prepare("DELETE FROM transactions WHERE id = 201").run();
    const { results } = await env.DB.prepare("SELECT count(*) AS n FROM transaction_tags WHERE transaction_id = 201").all<{ n: number }>();
    expect(results[0].n).toBe(0);
  });
});

describe("routing", () => {
  it("405s a wrong method on an API path", async () => {
    expect((await call("/transactions", { method: "DELETE" })).status).toBe(405);
  });
});
