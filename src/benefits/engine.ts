import { type Benefit, type Product, PRODUCTS, productById } from "./catalog";

/** ABC: which product each card is, and for each benefit and period how much was credited, from
 * the transactions. Pure functions over a few hundred rows that SQL already picked out (see
 * src/routes/benefits.ts), so a request stays well inside the free plan's CPU.
 *
 * Rules:
 *  - A credit (negative amount) counts in the period of the purchase it paid back, when there's
 *    one at the benefit's merchants on the same card in the 60 days before it; otherwise in the
 *    period it posted. A positive row with a credit's description is that credit being reversed,
 *    and counts where it posted. Used = net credits, capped at the period's amount.
 *  - A purchase with no credit yet, in a period that ended less than 8 weeks ago, is "charged,
 *    credit pending" (Amex can take up to 8 weeks).
 *  - Periods belong to the year they start in, for the year's totals. */

export interface CardRow {
  id: number;
  owner: string;
  bank: string | null;
  name: string | null;              // Plaid's: what products are recognised by
  shown?: string | null;            // the name pages show (src/accounts.ts)
  mask: string | null;
  product_id: string | null;        // card_products: null = automatic, 'none' = no credits
  anniversary_month: number | null;
  hidden: number;
}

export interface TxnRow {
  id: number;
  account_id: number;
  date: string;                     // YYYY-MM-DD
  amount_cents: number;             // Plaid sign: positive = money out
  name: string | null;
  merchant_name: string | null;
  /** The patterns this row matches, from SQL, comma-separated: i = allPatterns()[i] matches its
   * name (description), MERCHANT_HIT + i = only its merchant_name. Missing: worked out here. */
  hits?: string | null;
}

export type Status = "used" | "partial" | "pending" | "locked" | "open" | "missed" | "upcoming";

export interface PeriodOut {
  start: string;
  end: string;
  label: string;
  cap_cents: number;
  used_cents: number;
  pending_cents: number;
  /** Purchases at the benefit's merchants that no credit paid back (e.g. not enrolled). */
  unpaid_cents: number;
  status: Status;
  marked?: boolean;                 // outside credits: ticked by hand
  in_year: boolean;                 // starts in the requested year (counted in its totals)
}

export interface BenefitOut {
  id: string;
  name: string;
  amount_cents: number;
  period: Benefit["period"];
  basis: Benefit["basis"];
  how: Benefit["how"];
  enroll: boolean;
  label_seen: boolean;
  note: string;
  source: string;
  periods: PeriodOut[];
  current: PeriodOut | null;
  unlock?: { spent_cents: number; needed_cents: number };
  once?: { last_used: string | null; next_from: string | null; data_since: string | null; status: "used" | "open" };
  used_this_year_cents: number;
}

export interface CardOut {
  account_id: number;
  owner: string;
  bank: string | null;
  name: string | null;
  mask: string | null;
  hidden: boolean;
  product: { id: string; name: string; issuer: string; fee_cents: number } | null;
  product_source: "chosen" | "name" | "credits" | "none";
  card_year?: { month: number; source: "chosen" | "annual_fee" | "default" };
  benefits: BenefitOut[];
  totals: Totals;
}

export interface Totals { available_cents: number; used_cents: number; open_now_cents: number; missed_cents: number; pending_cents: number }

const zero = (): Totals => ({ available_cents: 0, used_cents: 0, open_now_cents: 0, missed_cents: 0, pending_cents: 0 });

// --- LIKE patterns (%, case-insensitive for ASCII, as in SQLite) without regular expressions:
// a pattern is literal pieces between %s, found in order with indexOf. No compile step, which
// matters on a cold isolate (the free plan allows 10 ms of CPU per request). -------------------

export type Matcher = (lowercased: string) => boolean;
const compiled = new Map<string, Matcher>();

function one(pattern: string): Matcher {
  const parts = pattern.toLowerCase().split("%");
  const first = parts[0], last = parts[parts.length - 1], middle = parts.slice(1, -1).filter(Boolean);
  if (parts.length === 1) return (s) => s === first;
  return (s) => {
    if (!s.startsWith(first) || !s.endsWith(last) || s.length < first.length + last.length) return false;
    let at = first.length;
    const stop = s.length - last.length;
    for (const m of middle) {
      const i = s.indexOf(m, at);
      if (i < 0 || i + m.length > stop) return false;
      at = i + m.length;
    }
    return true;
  };
}

/** One matcher for a list of LIKE patterns (any of them). Callers pass lowercased text. */
export function likeMatcher(patterns: string[]): Matcher {
  const key = patterns.join("\u0000");
  let m = compiled.get(key);
  if (!m) {
    const all = patterns.map(one);
    m = (s) => all.some((f) => f(s));
    compiled.set(key, m);
  }
  return m;
}

// Each row carries the set of patterns it matches, so a benefit's check is a set lookup. SQL
// fills it in (src/routes/benefits.ts): matching ~100 patterns in the Worker costs more than a
// cold isolate's 10 ms of CPU.
type Tagged = TxnRow & { hit: Set<number> };
let patternIndex: Map<string, number> | null = null;
const indexOf = () => patternIndex ??= new Map(allPatterns().map((p, i) => [p, i]));

export const MERCHANT_HIT = 1000;

export function tag(t: TxnRow): Tagged {
  if (t.hits !== undefined && t.hits !== null) return { ...t, hit: new Set(t.hits.split(",").filter(Boolean).map(Number)) };
  const n = (t.name ?? "").toLowerCase(), mn = (t.merchant_name ?? "").toLowerCase();
  const hit = new Set<number>();
  for (const [p, i] of indexOf()) {
    const m = likeMatcher([p]);
    if (m(n)) hit.add(i); else if (m(mn)) hit.add(MERCHANT_HIT + i);
  }
  return { ...t, hit };
}
const ids = (patterns: string[] | undefined) => (patterns ?? []).map((p) => indexOf().get(p)!);
/** Credits match on their description; purchases on description or merchant. */
const creditHit = (t: Tagged, set: number[]) => set.some((i) => t.hit.has(i));
const chargeHit = (t: Tagged, set: number[]) => set.some((i) => t.hit.has(i) || t.hit.has(MERCHANT_HIT + i));
/** ISO dates compare as strings; localeCompare would load ICU collation on a cold isolate. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// --- products ----------------------------------------------------------------------------------

export function productFor(card: CardRow, rows: Tagged[]): { product: Product | null; source: CardOut["product_source"] } {
  if (card.product_id === "none") return { product: null, source: "none" };
  if (card.product_id && productById.has(card.product_id)) return { product: productById.get(card.product_id)!, source: "chosen" };
  for (const p of PRODUCTS) {
    if (!likeMatcher([p.institution])((card.bank ?? "").toLowerCase())) continue;
    if (likeMatcher(p.accountNames)((card.name ?? "").toLowerCase())) return { product: p, source: "name" };
    if (p.creditEvidence && rows.some((t) => t.amount_cents < 0 && creditHit(t, ids(p.creditEvidence)))) {
      return { product: p, source: "credits" };
    }
  }
  return { product: null, source: "none" };
}

// --- periods -----------------------------------------------------------------------------------

const MONTHS: Record<Exclude<Benefit["period"], "every_4_years">, number> = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function addMonths(y: number, m: number, n: number): [number, number] {
  const i = y * 12 + (m - 1) + n;
  return [Math.floor(i / 12), (i % 12) + 1];
}
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The first day of the period containing `date`. */
export function periodStart(date: string, b: Benefit, anniversary: number): string {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  if (b.period === "every_4_years") return date;
  const len = MONTHS[b.period];
  const first = b.basis === "card_year" ? anniversary : 1;
  const offset = (((m - first) % 12) + 12) % 12;
  const [sy, sm] = addMonths(y, m, -(offset % len));
  return ymd(sy, sm, 1);
}

function periodOf(start: string, b: Benefit): { start: string; end: string; label: string } {
  const y = Number(start.slice(0, 4)), m = Number(start.slice(5, 7));
  const len = MONTHS[b.period as keyof typeof MONTHS];
  const [ey, em] = addMonths(y, m, len - 1);
  const end = ymd(ey, em, lastDay(ey, em));
  const label = len === 1 ? `${MON[m - 1]} ${y}`
    : len === 3 && b.basis === "calendar" ? `Q${(m + 2) / 3} ${y}`
    : len === 12 && m === 1 ? String(y)
    : `${MON[m - 1]} ${y}–${MON[em - 1]} ${ey}`;
  return { start, end, label };
}

/** Periods shown for `year`: those overlapping it (a card year that started last year too). */
function periodsShown(b: Benefit, year: number, anniversary: number) {
  const out: { start: string; end: string; label: string }[] = [];
  let start = periodStart(ymd(year, 1, 1), b, anniversary);
  while (start <= ymd(year, 12, 31)) {
    const p = periodOf(start, b);
    out.push(p);
    const [ny, nm] = addMonths(Number(p.end.slice(0, 4)), Number(p.end.slice(5, 7)), 1);
    start = ymd(ny, nm, 1);
  }
  return out;
}

const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 8.64e7;
const capFor = (b: Benefit, start: string) => b.amountCents + (b.decemberExtraCents && start.slice(5, 7) === "12" ? b.decemberExtraCents : 0);

// --- credits per period ------------------------------------------------------------------------

const MATCH_DAYS = 60;          // a purchase this long before a credit can be the one it pays back
const PENDING_DAYS = 56;        // Amex: credits can take up to 8 weeks

interface Ledger { net: Map<string, number>; spend: Map<string, number>; unpaid: Map<string, number>; credits: TxnRow[] }

const SPILL_DAYS = 15;
const AHEAD_DAYS = 3;           // a credit can post while its purchase is still pending (Walmart+)           // Amex sometimes credits by statement month (two credits in May, none in April)
const REFUND_DAYS = 120;

function ledger(b: Benefit, rows: Tagged[], anniversary: number, cap = (start: string) => capFor(b, start)): Ledger {
  const creditSet = ids(b.credit), chargeSet = ids(b.charge), refundSet = ids(b.creditAsRefund?.names);
  const labelled = rows.filter((t) => (creditSet.length && creditHit(t, creditSet))
    || (refundSet.length && t.amount_cents < 0 && -t.amount_cents <= b.creditAsRefund!.maxCents && creditHit(t, refundSet)));
  const labelledIds = new Set(labelled.map((t) => t.id));
  const atMerchant = chargeSet.length ? rows.filter((t) => !labelledIds.has(t.id) && chargeHit(t, chargeSet)) : [];
  const charges = atMerchant.filter((t) => t.amount_cents > 0);
  const byDate = (a: TxnRow, z: TxnRow) => cmp(a.date, z.date) || a.id - z.id;

  // Money back at the merchant: a refund when it equals an earlier purchase (a cancelled stay),
  // otherwise, for credits that post under the merchant's name (Hilton: "Hilton" -$50), a credit.
  const refunds: { refund: TxnRow; of: TxnRow }[] = [];
  const merchantCredits: TxnRow[] = [];
  const refunded = new Set<number>();
  for (const t of atMerchant.filter((x) => x.amount_cents < 0).sort(byDate)) {
    const of = charges.filter((c) => !refunded.has(c.id) && c.amount_cents === -t.amount_cents && c.date <= t.date && daysBetween(c.date, t.date) <= REFUND_DAYS)
      .sort((a, z) => byDate(z, a))[0];
    if (of) { refunded.add(of.id); refunds.push({ refund: t, of }); }
    else if (b.merchantCredit && -t.amount_cents <= cap(periodStart(t.date, b, anniversary))) merchantCredits.push(t);
  }
  const credits = [...labelled, ...merchantCredits].sort(byDate);

  const left = new Map(charges.map((c) => [c.id, c.amount_cents]));
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  const net = new Map<string, number>(), spend = new Map<string, number>(), unpaid = new Map<string, number>();
  const room = (ps: string) => (net.get(ps) ?? 0) < cap(ps);

  for (const c of charges) if (!refunded.has(c.id)) add(spend, periodStart(c.date, b, anniversary), c.amount_cents);
  const newestFirst = [...charges].sort((a, z) => byDate(z, a));
  for (const t of credits) {
    let target = periodStart(t.date, b, anniversary);
    if (t.amount_cents < 0) {
      // the latest purchase before it with something left to pay back, in a period that still
      // has room (otherwise June's credit could land on a May purchase May's credit already paid)
      for (const c of newestFirst) {
        if (daysBetween(t.date, c.date) > AHEAD_DAYS) continue;    // can post just before its purchase
        if (daysBetween(c.date, t.date) > MATCH_DAYS) break;
        const ps = periodStart(c.date, b, anniversary);
        if (left.get(c.id)! > 0 && (ps === target || room(ps))) {
          target = ps;
          left.set(c.id, Math.max(0, left.get(c.id)! + t.amount_cents));
          break;
        }
      }
      // already full: early in a period, it's most likely last period's credit by statement month
      if (!room(target) && b.period !== "annual" && daysBetween(target, t.date) <= SPILL_DAYS) {
        const [y, m] = addMonths(Number(target.slice(0, 4)), Number(target.slice(5, 7)), -1);
        const prev = periodStart(ymd(y, m, 1), b, anniversary);
        if (room(prev)) target = prev;
      }
    }
    add(net, target, -t.amount_cents);
  }
  for (const { of } of refunds) left.set(of.id, 0);       // nothing to pay back on a cancelled purchase
  for (const c of charges) if (left.get(c.id)! > 0) add(unpaid, periodStart(c.date, b, anniversary), left.get(c.id)!);
  return { net, spend, unpaid, credits };
}

export interface Input {
  disabledCredits?: Set<string>;
  year: number;
  today: string;                    // YYYY-MM-DD
  cards: CardRow[];
  rows: TxnRow[];                   // matching rows on those cards (credits, purchases, evidence)
  firstFee: Map<number, string>;    // account_id -> date of its earliest annual fee
  dataSince: Map<number, string>;   // account_id -> its oldest transaction
  marks: Set<string>;               // `${account_id}|${benefit_id}|${period_start}`
}

export function computeCard(card: CardRow, input: Input, cardRows = input.rows.filter((t) => t.account_id === card.id)): CardOut {
  const rows = cardRows.map(tag);
  const { product, source } = productFor(card, rows);
  const out: CardOut = {
    account_id: card.id, owner: card.owner, bank: card.bank, name: card.shown ?? card.name, mask: card.mask, hidden: !!card.hidden,
    product: product && { id: product.id, name: product.name, issuer: product.issuer, fee_cents: product.feeCents },
    product_source: source, benefits: [], totals: zero(),
  };
  if (!product) return out;

  const fee = input.firstFee.get(card.id);
  const anniversary = card.anniversary_month ?? (fee ? Number(fee.slice(5, 7)) : 1);
  if (product.benefits.some((b) => b.basis === "card_year")) {
    out.card_year = { month: anniversary, source: card.anniversary_month ? "chosen" : fee ? "annual_fee" : "default" };
  }

  const ledgers = new Map<string, Ledger>();
  for (const b of product.benefits) {
    const caps = (start: string) => capFor(b, start);
    let L: Ledger;
    if (b.after) {
      // what's left of the shared credits once the first benefit is full
      const base = product.benefits.find((x) => x.id === b.after)!;
      const bl = ledgers.get(base.id)!;
      const net = new Map([...bl.net].map(([k, v]) => [k, Math.max(0, v - capFor(base, k))]));
      const own = ledger({ ...b, credit: [] }, rows, anniversary);
      L = { net, spend: own.spend, unpaid: new Map(), credits: [] };
    } else {
      L = ledger(b, rows, anniversary);
    }
    ledgers.set(b.id, L);
    // Disabled benefits still supply their ledger to dependent tiers (e.g. Dell).
    if (input.disabledCredits?.has(`${product.id}|${b.id}`)) continue;

    const bo: BenefitOut = {
      id: b.id, name: b.name, amount_cents: b.amountCents, period: b.period, basis: b.basis, how: b.how, enroll: b.enroll,
      label_seen: !!b.labelSeen, note: b.note, source: b.source, periods: [], current: null, used_this_year_cents: 0,
    };

    if (b.period === "every_4_years") {
      const last = L.credits.filter((t) => t.amount_cents < 0).map((t) => t.date).sort().at(-1) ?? null;
      const [ny, nm] = last ? addMonths(Number(last.slice(0, 4)), Number(last.slice(5, 7)), 48) : [0, 0];
      bo.once = { last_used: last, next_from: last ? ymd(ny, nm, Math.min(Number(last.slice(8, 10)), lastDay(ny, nm))) : null,
                  data_since: input.dataSince.get(card.id) ?? null, status: last && ymd(ny, nm, 1) > input.today ? "used" : "open" };
      out.benefits.push(bo);
      continue;
    }

    for (const p of periodsShown(b, input.year, anniversary)) {
      const cap = caps(p.start);
      const inYear = p.start.startsWith(String(input.year));
      const used = Math.min(Math.max(L.net.get(p.start) ?? 0, 0), cap);
      const spent = L.spend.get(p.start) ?? 0;
      const ended = p.end < input.today;
      const recent = !ended || daysBetween(p.end, input.today) <= PENDING_DAYS;
      const pending = b.how === "on_card" && used < cap && recent ? Math.min(L.unpaid.get(p.start) ?? 0, cap - used) : 0;
      const marked = b.how === "outside" ? input.marks.has(`${card.id}|${b.id}|${p.start}`) : undefined;
      const locked = !!b.unlockSpendCents && spent < b.unlockSpendCents && used === 0;
      const usedCents = marked ? cap : used;
      const status: Status =
        p.start > input.today ? "upcoming"
        : usedCents >= cap ? "used"
        : pending > 0 ? "pending"
        : locked ? "locked"
        : usedCents > 0 ? "partial"
        : ended ? "missed" : "open";
      const unpaid = b.how === "on_card" && used < cap ? Math.min(L.unpaid.get(p.start) ?? 0, cap - used) : 0;
      const po: PeriodOut = { ...p, cap_cents: cap, used_cents: usedCents, pending_cents: pending, unpaid_cents: unpaid, status, in_year: inYear,
                              ...(marked !== undefined ? { marked } : {}) };
      bo.periods.push(po);
      if (p.start <= input.today && p.end >= input.today) bo.current = po;
      if (b.unlockSpendCents && p.start <= input.today && p.end >= input.today) bo.unlock = { spent_cents: spent, needed_cents: b.unlockSpendCents };

      if (!inYear) continue;
      bo.used_this_year_cents += usedCents;
      if (locked && status === "locked") continue;             // a spend-unlocked credit counts once it's unlocked
      const t = out.totals;
      t.available_cents += cap;
      t.used_cents += usedCents;
      const left = cap - usedCents;
      if (status === "upcoming") continue;
      if (ended && !recent) t.missed_cents += left;
      else if (ended) { t.pending_cents += pending; t.missed_cents += left - pending; }
      else { t.open_now_cents += left - pending; t.pending_cents += pending; }
    }
    out.benefits.push(bo);
  }
  return out;
}

export function compute(input: Input): { cards: CardOut[]; totals: Totals; ending_soon: EndingSoon[] } {
  const byCard = new Map<number, TxnRow[]>();
  for (const t of input.rows) (byCard.get(t.account_id) ?? byCard.set(t.account_id, []).get(t.account_id)!).push(t);
  const cards = input.cards.map((c) => computeCard(c, input, byCard.get(c.id) ?? []));
  const totals = zero();
  const ending: EndingSoon[] = [];
  for (const c of cards) {
    if (c.hidden || !c.product) continue;
    for (const k of Object.keys(totals) as (keyof Totals)[]) totals[k] += c.totals[k];
    for (const b of c.benefits) {
      const p = b.current;
      if (!p || ["used", "upcoming", "locked"].includes(p.status)) continue;
      const left = p.cap_cents - p.used_cents - p.pending_cents;
      if (left > 0) ending.push({ account_id: c.account_id, card: c.name, mask: c.mask, benefit_id: b.id, benefit: b.name,
                                  left_cents: left, ends: p.end, how: b.how, enroll: b.enroll });
    }
  }
  ending.sort((a, z) => cmp(a.ends, z.ends) || z.left_cents - a.left_cents);
  return { cards, totals, ending_soon: ending };
}

export interface EndingSoon { account_id: number; card: string | null; mask: string | null; benefit_id: string; benefit: string;
                              left_cents: number; ends: string; how: Benefit["how"]; enroll: boolean }

/** Which cards' transactions ABC must read, and which patterns (indexes into allPatterns()):
 * cards recognised by name or by choice, plus cards a product-only credit could identify (same
 * bank, nothing chosen). Hidden cards aren't read at all. */
export function scope(cards: CardRow[]): { accountIds: number[]; patterns: number[] } {
  const ids = new Set<number>(), pats = new Set<number>();
  const idx = indexOf();
  for (const c of cards) {
    if (c.hidden) continue;
    const { product } = productFor(c, []);
    const candidates = product ? [product]
      : c.product_id === "none" ? []
      : PRODUCTS.filter((p) => p.creditEvidence && likeMatcher([p.institution])((c.bank ?? "").toLowerCase()));
    if (!candidates.length) continue;
    ids.add(c.id);
    for (const p of candidates) {
      for (const e of p.creditEvidence ?? []) pats.add(idx.get(e)!);
      for (const b of p.benefits) for (const x of [...(b.credit ?? []), ...(b.charge ?? []), ...(b.creditAsRefund?.names ?? [])]) pats.add(idx.get(x)!);
    }
  }
  return { accountIds: [...ids].sort((a, b) => a - b), patterns: [...pats].sort((a, b) => a - b) };
}

/** Every LIKE pattern the SQL needs, to fetch only rows that can matter. */
export function allPatterns(): string[] {
  const s = new Set<string>();
  for (const p of PRODUCTS) {
    for (const e of p.creditEvidence ?? []) s.add(e);
    for (const b of p.benefits) for (const x of [...(b.credit ?? []), ...(b.charge ?? []), ...(b.creditAsRefund?.names ?? [])]) s.add(x);
  }
  return [...s];
}
