import { productPreferences } from "../benefits/preferences";
import type { Env } from "../env";
import { HttpError, intParam, json, jsonBody, unprocessable } from "../http";
import { CHECKED, NOT_TRACKED, PRODUCTS, productById } from "../benefits/catalog";
import { type CardRow, MERCHANT_HIT, type TxnRow, allPatterns, compute, periodStart, productFor, scope, tag } from "../benefits/engine";
import { ACCOUNT_NAME } from "../accounts";

/** ABC ("All but coupon clipping"): GET /benefits, the household's card credits for a year;
 * PUT /benefits/cards/:id, a card's product / card-year month / hidden; PUT /benefits/marks,
 * ticks for credits Minty can't see on a statement. */

// D1 bills rows read, and the free plan allows 5,000,000 a day. So /benefits reads each
// transaction of the cards ABC tracks exactly once (an index range per card), and SQLite tags
// each row with the patterns it matched (see TxnRow.hits), so the Worker does no string matching
// either (on a cold isolate that would use up its 10 ms of CPU). The patterns are inlined as one
// balanced expression: they're code, not input. Joining a json_each list of patterns instead
// reads every transaction once per pattern (hundreds of thousands of rows a request), and a
// chain of 100+ ORs or ||s exceeds SQLite's expression-depth limit of 100.

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const balanced = (parts: string[], op: string): string =>
  parts.length === 1 ? parts[0] : `(${balanced(parts.slice(0, parts.length >> 1), op)} ${op} ${balanced(parts.slice(parts.length >> 1), op)})`;

const FEE = `(t.amount_cents >= 0 AND t.name NOT LIKE '%REFUND%' AND (t.name LIKE '%MEMBERSHIP FEE%' OR t.name LIKE '%ANNUAL FEE%'))`;

/** The rows ABC needs from these cards: credits, qualifying purchases and evidence (hits), and
 * annual fees (fee = 1, for card years). One pass over each card's transactions. */
export function taggedRowsSql(accountCount: number, patterns: number[]): string {
  const all = allPatterns();
  const hits = patterns.length
    ? balanced(patterns.map((i) => `(CASE WHEN t.name LIKE ${lit(all[i])} THEN '${i},' WHEN t.merchant_name LIKE ${lit(all[i])} THEN '${MERCHANT_HIT + i},' ELSE '' END)`), "||")
    : "''";
  return `SELECT * FROM (
      SELECT t.id, t.account_id, t.date, t.amount_cents, t.name, t.merchant_name, ${hits} AS hits, ${FEE} AS fee
      FROM transactions t WHERE t.account_id IN (${Array(accountCount).fill("?").join(", ")}) AND t.pending = 0
    ) WHERE hits <> '' OR fee = 1`;
}

const CARDS = `
  SELECT a.id, a.owner, i.institution_name AS bank, a.name, ${ACCOUNT_NAME("a")} AS shown, a.mask, cp.product_id, cp.anniversary_month,
         coalesce(cp.hidden, 0) AS hidden
  FROM accounts a JOIN items i ON i.id = a.item_id LEFT JOIN card_products cp ON cp.account_id = a.id
  WHERE a.type = 'credit'`;

const today = () => new Date().toISOString().slice(0, 10);

export async function benefits(env: Env, url: URL): Promise<Response> {
  const now = today();
  const thisYear = Number(now.slice(0, 4));
  const year = intParam(url, "year", { def: thisYear, min: 2000, max: thisYear + 1 })!;

  const [cardsRes, marksRes] = await env.DB.batch([
    env.DB.prepare(`${CARDS} ORDER BY a.owner, i.id, a.name, a.id`),
    env.DB.prepare("SELECT account_id, benefit_id, period_start FROM benefit_marks"),
  ]);
  const cards = cardsRes.results as unknown as CardRow[];
  const { accountIds, patterns } = scope(cards);
  let rows: (TxnRow & { fee: number })[] = [];
  let since: { account_id: number; date: string | null }[] = [];
  if (accountIds.length) {
    const [r, s] = await env.DB.batch([
      env.DB.prepare(taggedRowsSql(accountIds.length, patterns)).bind(...accountIds),
      // a card's first transaction: one read each on idx_txn_account_date
      env.DB.prepare(`SELECT a.value AS account_id, (SELECT min(t.date) FROM transactions t WHERE t.account_id = a.value) AS date
                      FROM json_each(?) a`).bind(JSON.stringify(accountIds)),
    ]);
    rows = r.results as any;
    since = s.results as any;
  }
  const firstFee = new Map<number, string>();
  for (const t of rows) if (t.fee && !(firstFee.get(t.account_id)! <= t.date)) firstFee.set(t.account_id, t.date);
  const disabledCredits=await productPreferences(env);
  const result = compute({
    disabledCredits,
    year, today: now, cards,
    rows: rows.filter((t) => t.hits),
    firstFee,
    dataSince: new Map(since.filter((x) => x.date).map((x) => [x.account_id, x.date!])),
    marks: new Set((marksRes.results as { account_id: number; benefit_id: string; period_start: string }[])
      .map((m) => `${m.account_id}|${m.benefit_id}|${m.period_start}`)),
  });
  return json({
    year, today: now, checked: CHECKED, not_tracked: NOT_TRACKED,
    products: PRODUCTS.map((p) => ({ id: p.id, name: p.name, benefits:p.benefits.map(b=>({id:b.id,name:b.name,enabled:!disabledCredits.has(`${p.id}|${b.id}`)})) })),
    ...result,
  });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const b = await jsonBody(request);
    if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>;
  } catch (e) {
    if (e instanceof HttpError) throw e;          // too large
  }
  throw unprocessable("body must be a JSON object");
}

async function creditCard(env: Env, accountId: number): Promise<CardRow> {
  const card = await env.DB.prepare(`${CARDS} AND a.id = ?`).bind(accountId).first<CardRow>();
  if (!card) throw new HttpError(404, "credit card not found");
  return card;
}

/** PUT /benefits/cards/:id {product_id?: string | null, anniversary_month?: 1–12 | null, hidden?: boolean}.
 * product_id null = recognise it automatically; "none" = it has no tracked credits. */
export async function setCard(env: Env, request: Request, accountId: number): Promise<Response> {
  const b = await body(request);
  const card = await creditCard(env, accountId);
  let product = card.product_id, month = card.anniversary_month, hidden = !!card.hidden;
  if ("product_id" in b) {
    if (b.product_id !== null && (typeof b.product_id !== "string" || (b.product_id !== "none" && !productById.has(b.product_id)))) {
      throw unprocessable("product_id must be null, \"none\" or a known product");
    }
    product = b.product_id as string | null;
  }
  if ("anniversary_month" in b) {
    if (b.anniversary_month !== null && !(Number.isInteger(b.anniversary_month) && (b.anniversary_month as number) >= 1 && (b.anniversary_month as number) <= 12)) {
      throw unprocessable("anniversary_month must be null or 1–12");
    }
    month = b.anniversary_month as number | null;
  }
  if ("hidden" in b) {
    if (typeof b.hidden !== "boolean") throw unprocessable("hidden must be true or false");
    hidden = b.hidden;
  }
  await env.DB.prepare(
    `INSERT INTO card_products (account_id, product_id, anniversary_month, hidden) VALUES (?, ?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET product_id = excluded.product_id, anniversary_month = excluded.anniversary_month,
       hidden = excluded.hidden, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).bind(accountId, product, month, hidden ? 1 : 0).run();
  return json({ account_id: accountId, product_id: product, anniversary_month: month, hidden });
}

/** PUT /benefits/marks {account_id, benefit_id, period_start, used}: tick (or untick) a credit
 * Minty can't see on a statement, for one period. */
export async function setMark(env: Env, request: Request, email: string): Promise<Response> {
  const b = await body(request);
  if (!Number.isInteger(b.account_id)) throw unprocessable("account_id must be an integer");
  if (typeof b.benefit_id !== "string") throw unprocessable("benefit_id must be a string");
  if (typeof b.period_start !== "string" || !/^\d{4}-\d{2}-01$/.test(b.period_start) || Number.isNaN(Date.parse(b.period_start))) {
    throw unprocessable("period_start must be a period's first day (YYYY-MM-01)");
  }
  if (typeof b.used !== "boolean") throw unprocessable("used must be true or false");
  const card = await creditCard(env, b.account_id as number);
  const { patterns } = scope([{ ...card, hidden: 0 }]);
  const allRows = (await env.DB.prepare(taggedRowsSql(1, patterns)).bind(card.id).all<TxnRow & {fee:number}>()).results;
  const rows = allRows.filter(t=>t.hits);
  const { product } = productFor(card, rows.map(tag));
  const benefit = product?.benefits.find((x) => x.id === b.benefit_id);
  if (!benefit) throw new HttpError(404, "this card has no such credit");
  if (benefit.how !== "outside") throw unprocessable("only credits Minty can't see on a statement can be ticked");
  const firstFee=allRows.filter(t=>t.fee).map(t=>t.date).sort()[0];
  const anniversary=card.anniversary_month ?? (firstFee?Number(firstFee.slice(5,7)):1);
  if (periodStart(b.period_start as string, benefit, anniversary) !== b.period_start) throw unprocessable(`${b.period_start} doesn't start a period of this credit`);
  await (b.used
    ? env.DB.prepare(
        `INSERT INTO benefit_marks (account_id, benefit_id, period_start, marked_by) VALUES (?, ?, ?, ?)
         ON CONFLICT DO NOTHING`).bind(card.id, benefit.id, b.period_start, email)
    : env.DB.prepare("DELETE FROM benefit_marks WHERE account_id = ? AND benefit_id = ? AND period_start = ?")
        .bind(card.id, benefit.id, b.period_start)).run();
  return json({ account_id: card.id, benefit_id: benefit.id, period_start: b.period_start, used: b.used });
}
