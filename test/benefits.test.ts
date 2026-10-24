import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { CHECKED, PRODUCTS } from "../src/benefits/catalog";
import { type CardRow, type Input, type TxnRow, allPatterns, compute, likeMatcher, tag } from "../src/benefits/engine";
import { call, getJson } from "./helpers";

// ABC: the credit catalog, the matching engine (at a fixed "today"), and the /benefits routes on
// a real local D1.

let nextId = 1;
const txn = (account_id: number, date: string, dollars: number, name: string, merchant_name: string | null = null): TxnRow =>
  ({ id: nextId++, account_id, date, amount_cents: Math.round(dollars * 100), name, merchant_name });

const card = (id: number, name: string, bank = "American Express", o: Partial<CardRow> = {}): CardRow =>
  ({ id, owner: "me", bank, name, mask: String(9000 + id), product_id: null, anniversary_month: null, hidden: 0, ...o });

function run(cards: CardRow[], rows: TxnRow[], o: Partial<Input> = {}) {
  return compute({ year: 2026, today: "2026-10-12", cards, rows, firstFee: new Map(), dataSince: new Map(), marks: new Set(), ...o });
}
const benefit = (out: ReturnType<typeof run>, accountId: number, id: string) =>
  out.cards.find((c) => c.account_id === accountId)!.benefits.find((b) => b.id === id)!;
const period = (b: ReturnType<typeof benefit>, label: string) => b.periods.find((p) => p.label === label)!;

describe("catalog", () => {
  it("is well formed", () => {
    expect(CHECKED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Set(PRODUCTS.map((p) => p.id)).size).toBe(PRODUCTS.length);
    for (const p of PRODUCTS) {
      expect(new Set(p.benefits.map((b) => b.id)).size, p.id).toBe(p.benefits.length);
      expect(p.accountNames.length + (p.creditEvidence?.length ?? 0), p.id).toBeGreaterThan(0);
      for (const b of p.benefits) {
        const where = `${p.id}.${b.id}`;
        expect(b.amountCents, where).toBeGreaterThan(0);
        expect(b.source, where).toMatch(/^https:\/\//);
        expect(b.note.length, where).toBeGreaterThan(10);
        if (b.how === "outside") expect(b.credit ?? [], where).toEqual([]);
        else expect(b.credit?.length, where).toBeGreaterThan(0);
        // a credit pattern names the credit, so a purchase can never look like a reversal of one
        for (const c of b.credit ?? []) expect(c.toLowerCase(), where).toContain("credit");
        // no short word that could sit inside another one ("%oura%" in "Tourane")
        for (const c of [...(b.credit ?? []), ...(b.charge ?? [])]) expect(c, where).not.toMatch(/^%[a-z]{1,4}%$/i);
        if (b.after) expect(p.benefits.some((x) => x.id === b.after), where).toBe(true);
        if (b.creditAsRefund) {
          for (const n of b.creditAsRefund.names) expect(n, where).not.toContain("%");          // exact names only
          expect(b.creditAsRefund.maxCents, where).toBeLessThanOrEqual(Math.round(b.amountCents * 1.2));
        }
      }
    }
  });

  it("matches the same rows in JavaScript as SQLite's LIKE does", async () => {
    const texts = ["Platinum Resy Credit", "DELL INC", "Dell Statement Credit Benefit", "PINE RIDGE RESORT WISCONSIN DELLS",
      "FLEXIBLE BUSINESS CREDIT", "UPS* 1Z999", "UPS STORE 123", "GRUBHUB*ORDER", "Annual Travel/dining Credit (p To $325)",
      "WMT PLUS Jan 2026", "Walmart+", "ChatGPT Business Credit", "OPENAI *CHATGPT SUBSCR", "lululemon athletica", "X"];
    const patterns = allPatterns();
    const { results } = await env.DB.prepare(
      "SELECT t.value AS text, p.value AS pattern FROM json_each(?1) t JOIN json_each(?2) p ON t.value LIKE p.value",
    ).bind(JSON.stringify(texts), JSON.stringify(patterns)).all<{ text: string; pattern: string }>();
    const sql = new Set(results.map((r) => `${r.text}|${r.pattern}`));
    const js = new Set(texts.flatMap((t) => patterns.filter((p) => likeMatcher([p])(t.toLowerCase())).map((p) => `${t}|${p}`)));
    expect(js).toEqual(sql);
    expect(sql.size).toBeGreaterThan(10);
  });
});

describe("recognising cards", () => {
  it("by name, with Business Platinum never taken for the personal Platinum", () => {
    const out = run([card(1, "Business Platinum Card®"), card(2, "Charles Schwab Platinum Card®"), card(3, "Business Gold Card"),
      card(4, "Citi Strata Premier® Card", "Citibank Online"), card(5, "Blue Business Plus Card"), card(6, "Citi Double Cash® Card", "Citibank Online")], []);
    expect(out.cards.map((c) => [c.account_id, c.product?.id ?? null, c.product_source])).toEqual([
      [1, "amex_business_platinum", "name"], [2, "amex_platinum", "name"], [3, "amex_business_gold", "name"],
      [4, "citi_strata_premier", "name"], [5, null, "none"], [6, null, "none"]]);
  });

  it("by a credit only that product gets, or as chosen", () => {
    const us = card(7, "Credit Card - 9104", "U.S. Bank");
    expect(run([us], []).cards[0].product).toBeNull();
    expect(run([us], [txn(7, "2025-10-14", -300, "Annual Travel/dining Credit (p To $325)")]).cards[0])
      .toMatchObject({ product: { id: "usbank_altitude_reserve" }, product_source: "credits" });
    expect(run([{ ...us, product_id: "usbank_altitude_reserve" }], []).cards[0].product_source).toBe("chosen");
    expect(run([card(1, "Business Platinum Card®", "American Express", { product_id: "none" })], []).cards[0].product).toBeNull();
  });
});

describe("matching credits", () => {
  it("counts a credit against its purchase, and never a merchant that only looks similar", () => {
    const out = run([card(1, "Business Platinum Card®")], [
      txn(1, "2026-06-22", 200, "DELL INC", "Dell Inc. (h Q)"), txn(1, "2026-06-23", -150, "Dell Statement Credit Benefit"),
      txn(1, "2026-08-28", -100, "PINE RIDGE RESORT WISCONSIN DELLS"),
    ]);
    expect(period(benefit(out, 1, "dell"), "2026")).toMatchObject({ used_cents: 15000, status: "used", unpaid_cents: 0 });
    expect(benefit(out, 1, "dell_plus").current).toMatchObject({ status: "locked", used_cents: 0 });
    expect(benefit(out, 1, "dell_plus").unlock).toEqual({ spent_cents: 20000, needed_cents: 500000 });
  });

  it("gives the second Dell credit what's left once the first is full, after $5,000 at Dell", () => {
    const out = run([card(1, "Business Platinum Card®")], [
      txn(1, "2026-03-02", 5200, "DELL INC"), txn(1, "2026-03-04", -150, "Dell Statement Credit Benefit"),
      txn(1, "2026-03-20", -1000, "Dell Statement Credit Benefit"),
    ]);
    expect(benefit(out, 1, "dell").current).toMatchObject({ used_cents: 15000, status: "used" });
    expect(benefit(out, 1, "dell_plus").current).toMatchObject({ used_cents: 100000, status: "used" });
  });

  it("counts a credit that posts next month in the month of its purchase", () => {
    const out = run([card(3, "Business Gold Card")], [
      txn(3, "2026-04-20", 25, "GRUBHUB*ORDER"), txn(3, "2026-05-02", -20, "FLEXIBLE BUSINESS CREDIT"),
      txn(3, "2026-05-08", 31, "STAPLES 0042"), txn(3, "2026-05-10", -20, "FLEXIBLE BUSINESS CREDIT"),
      txn(3, "2026-06-03", -6.25, "FLEXIBLE BUSINESS CREDIT"), txn(3, "2026-06-14", -13.75, "FLEXIBLE BUSINESS CREDIT"),
    ]);
    const f = benefit(out, 3, "flexible");
    expect([period(f, "Apr 2026").status, period(f, "May 2026").status, period(f, "Jun 2026").status]).toEqual(["used", "used", "used"]);
    expect(period(f, "Mar 2026")).toMatchObject({ status: "missed", used_cents: 0 });
    expect(f.current).toMatchObject({ label: "Oct 2026", status: "open" });
    expect(period(f, "Nov 2026").status).toBe("upcoming");
  });

  it("counts a credit posted under the merchant's name (Hilton), and a cancelled stay as a refund, not a missing credit", () => {
    const out = run([card(1, "Business Platinum Card®")], [
      txn(1, "2026-03-28", 412.30, "Hilton", "Hilton Downtown"), txn(1, "2026-03-29", -50, "Hilton"), txn(1, "2026-04-02", -412.30, "Hilton"),
      txn(1, "2026-07-01", 388.10, "Hilton", "Hilton Downtown"), txn(1, "2026-07-02", -50, "Hilton"), txn(1, "2026-07-08", -388.10, "Hilton"),
      txn(1, "2026-05-10", 300, "HAMPTON INN DENVER"),
    ]);
    const h = benefit(out, 1, "hilton");
    expect(h.periods.map((p) => [p.label, p.status, p.used_cents, p.unpaid_cents])).toEqual([
      ["Q1 2026", "used", 5000, 0], ["Q2 2026", "missed", 0, 5000], ["Q3 2026", "used", 5000, 0], ["Q4 2026", "open", 0, 0]]);
  });

  it("puts a second credit early in a full month into last month (Amex crediting by statement month)", () => {
    const out = run([card(3, "Business Gold Card")], [
      txn(3, "2026-05-01", 20, "Staples", "Staples"), txn(3, "2026-05-02", -20, "FLEXIBLE BUSINESS CREDIT"),
      txn(3, "2026-05-09", 20, "Staples", "Staples"), txn(3, "2026-05-10", -20, "FLEXIBLE BUSINESS CREDIT"),
      txn(3, "2026-07-20", 20, "Staples", "Staples"), txn(3, "2026-07-21", -20, "FLEXIBLE BUSINESS CREDIT"),
      txn(3, "2026-07-25", 20, "Staples", "Staples"), txn(3, "2026-07-26", -20, "FLEXIBLE BUSINESS CREDIT"),
    ]);
    const f = benefit(out, 3, "flexible");
    expect([period(f, "Apr 2026").status, period(f, "May 2026").status]).toEqual(["used", "used"]);
    expect([period(f, "Jun 2026").status, period(f, "Jul 2026").used_cents]).toEqual(["missed", 2000]);   // late in July: no spill
  });

  it("matches the wireless credit to the carrier's bill", () => {
    const w = benefit(run([card(1, "Business Platinum Card®")], [
      txn(1, "2026-02-28", 10, "T-Mobile", "T-Mobile"), txn(1, "2026-03-02", -10, "AMEX Wireless Credit"),
      txn(1, "2026-09-27", 10, "TMOBILE WEB UPGRADE", "T-Mobile"),
    ]), 1, "wireless");
    expect([period(w, "Feb 2026").status, period(w, "Mar 2026").status]).toEqual(["used", "missed"]);
    expect(period(w, "Sep 2026")).toMatchObject({ status: "pending", pending_cents: 1000 });
  });

  it("nets reversed credits (Amex's hotel credit going back and forth)", () => {
    const out = run([card(2, "Charles Schwab Platinum Card®")], [
      txn(2, "2026-01-30", 250, "Platinum Hotel Credit", "Platinum Hotel"), txn(2, "2026-06-26", -550, "Platinum Hotel Credit"),
      txn(2, "2026-07-04", 550, "Platinum Hotel Credit", "Platinum Hotel"), txn(2, "2026-07-08", -850, "Platinum Hotel Credit"),
    ]);
    const h = benefit(out, 2, "hotel");
    expect(h.periods.map((p) => [p.label, p.used_cents, p.status])).toEqual([["Jan 2026–Jun 2026", 30000, "used"], ["Jul 2026–Dec 2026", 30000, "used"]]);
  });

  it("says when a purchase got no credit: pending for 8 weeks, then missed with the charge shown", () => {
    const rows = ["2026-02-28", "2026-08-28", "2026-09-29"].map((d) => txn(2, d, 13.86, "WMT PLUS", "Walmart+"));
    const w = benefit(run([card(2, "Charles Schwab Platinum Card®")], rows), 2, "walmart_plus");
    expect(period(w, "Feb 2026")).toMatchObject({ status: "missed", unpaid_cents: 1295, pending_cents: 0 });
    expect(period(w, "Aug 2026")).toMatchObject({ status: "pending", pending_cents: 1295 });
    expect(period(w, "Sep 2026")).toMatchObject({ status: "pending", pending_cents: 1295 });
    expect(period(w, "Jan 2026")).toMatchObject({ status: "missed", unpaid_cents: 0 });
  });

  it("counts Walmart+'s credit, which posts as a \"Walmart\" refund of the membership charge", () => {
    const rows = [
      txn(2, "2026-02-28", 13.86, "Walmart", "Walmart+"), txn(2, "2026-03-01", -13.86, "Walmart"),     // credited the next day
      txn(2, "2026-04-28", 13.86, "Walmart", "Walmart"), txn(2, "2026-04-29", -13.86, "Walmart"),      // charge without "+"
      txn(2, "2026-05-27", -13.86, "Walmart"), txn(2, "2026-05-28", 13.86, "WMT PLUS May 2026", "Walmart+"),   // credit first
      txn(2, "2026-06-10", 45.12, "Walmart", "Walmart"), txn(2, "2026-06-12", -45.12, "Walmart"),     // a store refund: not the credit
      txn(2, "2026-09-29", 13.86, "Walmart", "Walmart+"),
    ];
    const w = benefit(run([card(2, "Charles Schwab Platinum Card®")], rows), 2, "walmart_plus");
    expect(["Feb 2026", "Mar 2026", "Apr 2026", "May 2026", "Jun 2026", "Sep 2026"].map((l) => [l, period(w, l).status])).toEqual([
      ["Feb 2026", "used"], ["Mar 2026", "missed"], ["Apr 2026", "used"], ["May 2026", "used"], ["Jun 2026", "missed"], ["Sep 2026", "pending"]]);
    expect(period(w, "Feb 2026").used_cents).toBe(1295);                                              // capped at $12.95 (+ tax was paid back too)
  });

  it("caps a credit at its amount and shows partial use", () => {
    const out = run([card(2, "Charles Schwab Platinum Card®")], [
      txn(2, "2026-04-01", 50, "LULULEMON #0423", "Lululemon"), txn(2, "2026-04-02", -50, "Platinum Lululemon Credit"),
      txn(2, "2026-01-05", 140, "RESY*RESTAURANT"), txn(2, "2026-01-07", -100, "Platinum Resy Credit"), txn(2, "2026-01-20", -60, "Platinum Resy Credit"),
    ]);
    expect(period(benefit(out, 2, "lululemon"), "Q2 2026")).toMatchObject({ used_cents: 5000, status: "partial" });
    expect(period(benefit(out, 2, "resy"), "Q1 2026")).toMatchObject({ used_cents: 10000, status: "used" });
  });

  it("follows the card year, from the first annual fee or as chosen", () => {
    const us = card(7, "Credit Card - 9104", "U.S. Bank");
    const rows = [txn(7, "2025-10-08", -25, "Annual Travel/dining Credit (p To $325)"), txn(7, "2025-10-14", -300, "Annual Travel/dining Credit (p To $325)")];
    const out = run([us], rows, { firstFee: new Map([[7, "2024-10-18"]]) });
    const t = benefit(out, 7, "travel");
    expect(out.cards[0].card_year).toEqual({ month: 10, source: "annual_fee" });
    expect(t.periods.map((p) => [p.label, p.status, p.used_cents, p.in_year])).toEqual([
      ["Oct 2025–Sep 2026", "used", 32500, false], ["Oct 2026–Sep 2027", "open", 0, true]]);
    expect(out.cards[0].totals).toMatchObject({ available_cents: 32500, open_now_cents: 32500, used_cents: 0 });
    const chosen = run([{ ...us, anniversary_month: 1 }], rows, { firstFee: new Map([[7, "2024-10-18"]]) });
    expect(benefit(chosen, 7, "travel").periods.map((p) => p.label)).toEqual(["2026"]);
    expect(chosen.cards[0].card_year).toEqual({ month: 1, source: "chosen" });
  });

  it("counts a December purchase credited in January in December", () => {
    const rows = [txn(1, "2025-12-24", 162.40, "DELL INC"), txn(1, "2026-01-03", -150, "Dell Statement Credit Benefit")];
    expect(period(benefit(run([card(1, "Business Platinum Card®")], rows, { year: 2025, today: "2026-01-10" }), 1, "dell"), "2025").status).toBe("used");
    expect(period(benefit(run([card(1, "Business Platinum Card®")], rows), 1, "dell"), "2026").status).toBe("open");
  });

  it("tracks Global Entry over 4 years, outside the yearly totals", () => {
    const g = benefit(run([card(1, "Business Platinum Card®")], [txn(1, "2024-03-01", -120, "Global Entry Fee Credit")],
      { dataSince: new Map([[1, "2023-01-01"]]) }), 1, "global_entry");
    expect(g.once).toEqual({ last_used: "2024-03-01", next_from: "2028-03-01", data_since: "2023-01-01", status: "used" });
    expect(g.periods).toEqual([]);
  });

  it("ticks credits outside the card by hand, including December's extra Uber Cash", () => {
    const plat = card(2, "Charles Schwab Platinum Card®");
    const out = run([plat], [], { marks: new Set(["2|uber_cash|2026-09-01"]) });
    const u = benefit(out, 2, "uber_cash");
    expect(period(u, "Sep 2026")).toMatchObject({ status: "used", used_cents: 1500, marked: true });
    expect(period(u, "Aug 2026")).toMatchObject({ status: "missed", marked: false });
    expect(period(u, "Dec 2026")).toMatchObject({ cap_cents: 3500, status: "upcoming" });
    expect(u.used_this_year_cents).toBe(1500);
  });

  it("totals the household's cards, leaving out hidden ones and credits not unlocked yet, and lists what ends soonest", () => {
    const out = run([card(3, "Business Gold Card"), card(4, "Business Gold Card", "American Express", { hidden: 1 })], []);
    const gold = out.cards.find((c) => c.account_id === 3)!;
    // Flexible $240 + Walmart+ $155.40 + ChatGPT $300 + Squarespace $150 for the year
    expect(gold.totals.available_cents).toBe(24000 + 15540 + 30000 + 15000);
    expect(out.totals).toEqual(gold.totals);
    expect(out.ending_soon[0]).toMatchObject({ account_id: 3, ends: "2026-10-31" });
    expect(out.ending_soon.map((e) => e.ends)).toEqual([...out.ending_soon.map((e) => e.ends)].sort());
    const plat = run([card(1, "Business Platinum Card®")], []);
    expect(plat.cards[0].totals.available_cents).not.toBeGreaterThan(300000);     // the locked $1,000 Dell / $250 Adobe aren't counted
  });
});

// --- the routes, on local D1 ---------------------------------------------------------------

async function seed() {
  await env.DB.batch([
    ...["benefit_marks", "card_products", "transaction_tags", "transactions", "accounts", "items"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    env.DB.prepare(`INSERT INTO items (id, owner, plaid_account, plaid_item_id, access_token_enc, institution_name) VALUES
      (1, 'me', 'me_primary', 'amex', 'x', 'American Express'), (2, 'me', 'me_primary', 'usb', 'x', 'U.S. Bank')`),
    env.DB.prepare(`INSERT INTO accounts (id, owner, item_id, plaid_account_id, name, mask, type, subtype) VALUES
      (10, 'me', 1, 'a10', 'Business Platinum Card®', '9101', 'credit', 'credit card'),
      (11, 'me', 1, 'a11', 'Charles Schwab Platinum Card®', '9102', 'credit', 'credit card'),
      (12, 'me', 1, 'a12', 'Blue Business Plus Card', '9103', 'credit', 'credit card'),
      (20, 'me', 2, 'a20', 'Credit Card - 9104', '9104', 'credit', 'credit card'),
      (21, 'me', 2, 'a21', 'Checking', '0001', 'depository', 'checking')`),
    env.DB.prepare(`INSERT INTO transactions (owner, account_id, plaid_txn_id, amount_cents, date, name, merchant_name, pending) VALUES
      ('me', 10, 't1', 20000, '2026-06-22', 'DELL INC', 'Dell Inc. (h Q)', 0),
      ('me', 10, 't2', -15000, '2026-06-23', 'Dell Statement Credit Benefit', NULL, 0),
      ('me', 10, 't3', -10000, '2026-08-28', 'PINE RIDGE RESORT WISCONSIN DELLS', NULL, 0),
      ('me', 10, 't4', 4200, '2026-09-01', 'WHOLE FOODS', 'Whole Foods', 0),
      ('me', 11, 't5', 1428, '2026-02-28', 'Walmart', 'Walmart+', 0),
      ('me', 20, 't6', 0, '2024-10-18', 'Annual Membership Fee', NULL, 0),
      ('me', 20, 't7', -32500, '2025-10-14', 'Annual Travel/dining Credit (p To $325)', NULL, 0),
      ('me', 20, 't8', 9900, '2026-10-01', 'Annual Travel/dining Credit pending', NULL, 1)`),
  ]);
}

const put = (path: string, body: unknown) => call(path, { method: "PUT", body: JSON.stringify(body) });

describe("GET /benefits", () => {
  beforeEach(seed);

  it("reports each credit card, with its product, credits and the year's totals", async () => {
    const { status, body } = await getJson("/benefits?year=2026");
    expect(status).toBe(200);
    expect(body).toMatchObject({ year: 2026, checked: CHECKED, products: expect.arrayContaining([expect.objectContaining({ id: "amex_platinum", name: "American Express Platinum" })]) });
    const byId = (id: number) => body.cards.find((c: any) => c.account_id === id);
    expect(body.cards.map((c: any) => [c.account_id, c.product?.id ?? null])).toEqual([
      [12, null], [10, "amex_business_platinum"], [11, "amex_platinum"], [20, "usbank_altitude_reserve"]]);        // no checking accounts
    const dell = byId(10).benefits.find((b: any) => b.id === "dell");
    expect(dell.periods[0]).toMatchObject({ used_cents: 15000, status: "used" });                                  // the resort refund isn't Dell
    expect(byId(20).card_year).toEqual({ month: 10, source: "annual_fee" });
    expect(body.totals.available_cents).toBeGreaterThan(0);
  });

  it("tags rows in SQL exactly as the engine would on its own", async () => {
    const { results } = await env.DB.prepare(
      `SELECT t.id, t.account_id, t.date, t.amount_cents, t.name, t.merchant_name,
              group_concat(CASE WHEN t.name LIKE p.value THEN p.key ELSE p.key + 1000 END) AS hits
       FROM transactions t JOIN json_each(?) p ON t.name LIKE p.value OR t.merchant_name LIKE p.value GROUP BY t.id`,
    ).bind(JSON.stringify(allPatterns())).all<TxnRow>();
    expect(results.length).toBeGreaterThan(3);
    for (const r of results) expect([...tag(r).hit].sort(), r.name!).toEqual([...tag({ ...r, hits: undefined }).hit].sort());
  });

  it("refuses a year out of range", async () => {
    expect((await call("/benefits?year=1999")).status).toBe(422);
  });
});

describe("PUT /benefits/cards/:id", () => {
  beforeEach(seed);

  it("sets a card's product, card-year month and hidden flag, and back to automatic", async () => {
    let r = await put("/benefits/cards/12", { product_id: "amex_business_gold" });
    expect(await r.json()).toEqual({ account_id: 12, product_id: "amex_business_gold", anniversary_month: null, hidden: false });
    let c = (await getJson("/benefits")).body.cards.find((x: any) => x.account_id === 12);
    expect(c).toMatchObject({ product: { id: "amex_business_gold" }, product_source: "chosen" });

    await put("/benefits/cards/20", { anniversary_month: 1 });
    c = (await getJson("/benefits")).body.cards.find((x: any) => x.account_id === 20);
    expect(c.card_year).toEqual({ month: 1, source: "chosen" });

    const before = (await getJson("/benefits")).body.totals.available_cents;
    await put("/benefits/cards/10", { hidden: true });
    const after = (await getJson("/benefits")).body;
    expect(after.cards.find((x: any) => x.account_id === 10).hidden).toBe(true);
    expect(after.totals.available_cents).toBeLessThan(before);

    r = await put("/benefits/cards/12", { product_id: null });
    expect(((await r.json()) as any).product_id).toBeNull();
  });

  it("validates", async () => {
    expect((await put("/benefits/cards/12", { product_id: "made_up" })).status).toBe(422);
    expect((await put("/benefits/cards/12", { anniversary_month: 13 })).status).toBe(422);
    expect((await put("/benefits/cards/12", { hidden: "yes" })).status).toBe(422);
    expect((await put("/benefits/cards/21", { hidden: true })).status).toBe(404);          // a checking account
    expect((await put("/benefits/cards/999", { hidden: true })).status).toBe(404);
    expect((await call("/benefits/cards/12", { method: "PUT", body: "nope" })).status).toBe(422);
  });
});

describe("PUT /benefits/marks", () => {
  beforeEach(seed);
  const year = new Date().getUTCFullYear();

  it("ticks and unticks a credit Minty can't see, for one period", async () => {
    const mark = { account_id: 11, benefit_id: "uber_cash", period_start: `${year}-01-01`, used: true };
    expect((await put("/benefits/marks", mark)).status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM benefit_marks").first<any>();
    expect(row).toMatchObject({ account_id: 11, benefit_id: "uber_cash", period_start: `${year}-01-01`, marked_by: "me@example.com" });
    let u = (await getJson("/benefits")).body.cards.find((c: any) => c.account_id === 11).benefits.find((b: any) => b.id === "uber_cash");
    expect(u.periods[0]).toMatchObject({ marked: true, status: "used" });
    expect((await put("/benefits/marks", mark)).status).toBe(200);                         // again: still one row
    expect((await env.DB.prepare("SELECT count(*) AS n FROM benefit_marks").first<any>()).n).toBe(1);
    await put("/benefits/marks", { ...mark, used: false });
    u = (await getJson("/benefits")).body.cards.find((c: any) => c.account_id === 11).benefits.find((b: any) => b.id === "uber_cash");
    expect(u.periods[0].marked).toBe(false);
  });

  it("refuses credits Minty checks itself, unknown credits and dates that don't start a period", async () => {
    const base = { account_id: 11, benefit_id: "uber_cash", period_start: `${year}-01-01`, used: true };
    expect((await put("/benefits/marks", { ...base, benefit_id: "resy" })).status).toBe(422);
    expect((await put("/benefits/marks", { ...base, benefit_id: "nope" })).status).toBe(404);
    expect((await put("/benefits/marks", { ...base, account_id: 12 })).status).toBe(404);  // no product, no credits
    expect((await put("/benefits/marks", { ...base, period_start: `${year}-01-15` })).status).toBe(422);
    expect((await put("/benefits/marks", { ...base, used: "yes" })).status).toBe(422);
  });
});
