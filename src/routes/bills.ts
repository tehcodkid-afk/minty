import type { Env } from "../env";
import { type Config, credsFor, isConfigured } from "../config";
import { FernetError } from "../fernet";
import { openAccessToken } from "../token-key";
import { HttpError, json, jsonBody, unprocessable } from "../http";
import { plaidPost } from "../plaid";
import { bankHealth, bankRows } from "../health";
import type { ItemRow } from "../sync";
import { billStatus, listBills } from "./household-bills";
import { ACCOUNT_NAME } from "../accounts";

/** Bills (docs/bills.md), part 1: credit cards. GET /bills lists every credit card with its balance
 * and, where statement details are on for its bank, the latest statement (amount, minimum, due
 * date), whether it looks paid, and the statements seen before. POST /link/statements/complete
 * turns statement details on after Plaid Link; POST /statements/off turns them off. */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
export const ATTENTION_DAYS = 5;                 // unpaid this close to the due date: Needs attention
export const HISTORY_STATEMENTS = 12;

// A posted payment to the card after the statement closed (Plaid sign: money in is negative).
// Banks call it LOAN_PAYMENTS, sometimes a transfer in, and name it "payment" of some kind; refunds
// and rewards are neither, so they don't count.
const PAYMENT = `t.pending = 0 AND t.amount_cents < 0
  AND (t.category IN ('LOAN_PAYMENTS', 'TRANSFER_IN') OR upper(t.name) LIKE '%PAYMENT%')`;

// Every credit card, its bank, and its latest statement with the payments since. Index-driven:
// one card_statements lookup per card, and that card's transactions from its statement date to
// today (both ends bounded, so idx_txn_account_date reads only that range; test/reads.test.ts).
const CARDS_SQL = `
  SELECT a.id AS account_id, a.owner, ${ACCOUNT_NAME("a")} AS name, a.mask, a.balance_current_cents AS balance_cents, a.currency,
         i.id AS item_id, i.institution_name AS bank,
         ss.status AS statements_status, ss.synced_at AS statements_synced_at, ss.last_error AS statements_error,
         s.issue_date, s.balance_cents AS statement_cents, s.minimum_payment_cents, s.due_date,
         s.last_payment_cents, s.last_payment_date, s.is_overdue, s.marked_paid_at,
         CASE WHEN s.issue_date IS NULL THEN NULL ELSE
           (SELECT coalesce(sum(-t.amount_cents), 0) FROM transactions t
            WHERE t.account_id = a.id AND t.date > s.issue_date AND t.date <= date('now', '+2 days') AND ${PAYMENT}) END AS paid_cents
  FROM accounts a
  JOIN items i ON i.id = a.item_id
  LEFT JOIN statement_sync ss ON ss.item_id = i.id
  LEFT JOIN card_statements s ON s.account_id = a.id
       AND s.issue_date = (SELECT max(issue_date) FROM card_statements WHERE account_id = a.id)
  WHERE a.type = 'credit'
  ORDER BY s.due_date IS NULL, s.due_date, i.id, a.id`;

// Each card's last statements, newest first, with the payments seen between that statement and the next.
const HISTORY_SQL = `
  SELECT h.account_id, h.issue_date, h.balance_cents AS statement_cents, h.minimum_payment_cents, h.due_date, h.marked_paid_at,
         (SELECT coalesce(sum(-t.amount_cents), 0) FROM transactions t
          WHERE t.account_id = h.account_id AND t.date > h.issue_date
            AND t.date <= coalesce(h.next_issue, date('now', '+2 days')) AND ${PAYMENT}) AS paid_cents
  FROM (SELECT cs.*, lead(cs.issue_date) OVER (PARTITION BY cs.account_id ORDER BY cs.issue_date) AS next_issue,
               row_number() OVER (PARTITION BY cs.account_id ORDER BY cs.issue_date DESC) AS n
        FROM card_statements cs) h
  WHERE h.n <= ${HISTORY_STATEMENTS}
  ORDER BY h.account_id, h.issue_date DESC`;

export type CardStatus = "paid" | "partial" | "unpaid" | "overdue" | "nothing_due" | "unknown" | "no_statement";

interface CardRow {
  account_id: number; owner: string; name: string | null; mask: string | null; balance_cents: number | null; currency: string | null;
  item_id: number; bank: string | null;
  statements_status: string | null; statements_synced_at: string | null; statements_error: string | null;
  issue_date: string | null; statement_cents: number | null; minimum_payment_cents: number | null; due_date: string | null;
  last_payment_cents: number | null; last_payment_date: string | null; is_overdue: number | null; paid_cents: number | null;
  marked_paid_at: string | null;
}

const daysUntil = (date: string, today: string) => Math.round((Date.parse(date) - Date.parse(today)) / 864e5);

/** Whether a statement looks paid, from the payments seen on the card since it closed, cross-checked
 * with the bank's own last payment. Minty's estimate, not the bank's confirmation. A bank whose
 * transactions aren't current can't show an unpaid statement as unpaid: that's "unknown". A
 * statement marked paid by hand (paid from an account Minty doesn't see) is paid, whatever the
 * transactions say; `paid_how` says which it was. */
export function statementStatus(
  s: { statement_cents: number | null; due_date: string | null; paid_cents: number | null; issue_date: string;
       last_payment_cents?: number | null; last_payment_date?: string | null; is_overdue?: number | null; marked_paid_at?: string | null },
  today: string, feedCurrent: boolean,
): { status: CardStatus; attention: boolean; days_left: number | null; paid_how?: "marked" | "payments" | "bank" } {
  const owed = s.statement_cents ?? 0;
  const days = s.due_date ? daysUntil(s.due_date, today) : null;
  if (owed <= 0) return { status: "nothing_due", attention: false, days_left: days };
  if (s.marked_paid_at) return { status: "paid", attention: false, days_left: days, paid_how: "marked" };
  const bankSaysPaid = !!s.last_payment_date && s.last_payment_date > s.issue_date && (s.last_payment_cents ?? 0) >= owed;
  if ((s.paid_cents ?? 0) >= owed) return { status: "paid", attention: false, days_left: days, paid_how: "payments" };
  if (bankSaysPaid) return { status: "paid", attention: false, days_left: days, paid_how: "bank" };
  if (!feedCurrent) return { status: "unknown", attention: false, days_left: days };
  if (s.is_overdue === 1 || (days !== null && days < 0)) return { status: "overdue", attention: true, days_left: days };
  const soon = days !== null && days <= ATTENTION_DAYS;
  return { status: (s.paid_cents ?? 0) > 0 ? "partial" : "unpaid", attention: soon, days_left: days };
}

/** Health states whose transactions may be missing recent payments. */
const NOT_CURRENT = new Set(["downloading", "stalled", "reconnect", "broken", "stranded"]);

export async function bills(env: Env, config: Config): Promise<Response> {
  const today = new Date().toISOString().slice(0, 10);
  const [cardsRes, historyRes] = await env.DB.batch([env.DB.prepare(CARDS_SQL), env.DB.prepare(HISTORY_SQL)]);
  const rows = cardsRes.results as unknown as CardRow[];
  const history = new Map<number, Record<string, unknown>[]>();
  const banks = new Map((await bankRows(env)).map((r) => [r.id, bankHealth(env, config, r)]));
  const current = (itemId: number) => !NOT_CURRENT.has(banks.get(itemId)?.state ?? "ok");
  for (const h of historyRes.results as unknown as (Record<string, unknown> & { account_id: number })[]) {
    const card = rows.find((r) => r.account_id === h.account_id);
    const st = statementStatus(h as never, today, card ? current(card.item_id) : true);
    (history.get(h.account_id) ?? history.set(h.account_id, []).get(h.account_id)!).push({
      issue_date: h.issue_date, statement_cents: h.statement_cents, minimum_payment_cents: h.minimum_payment_cents,
      due_date: h.due_date, paid_cents: h.paid_cents, status: st.status, paid_how: st.paid_how ?? null, marked_paid_at: h.marked_paid_at ?? null,
    });
  }
  const cards = rows.map((r) => {
    const health = banks.get(r.item_id);
    const latest = r.issue_date ? statementStatus({ ...r, issue_date: r.issue_date }, today, current(r.item_id)) : null;
    return {
      account_id: r.account_id, owner: r.owner, bank: r.bank, item_id: r.item_id, name: r.name, mask: r.mask,
      balance_cents: r.balance_cents, currency: r.currency ?? "USD",
      statements: { status: r.statements_status ?? "off", synced_at: r.statements_synced_at, error: r.statements_error },
      latest: r.issue_date ? {
        issue_date: r.issue_date, statement_cents: r.statement_cents, minimum_payment_cents: r.minimum_payment_cents,
        due_date: r.due_date, paid_cents: r.paid_cents, last_payment_cents: r.last_payment_cents,
        last_payment_date: r.last_payment_date, is_overdue: r.is_overdue === null ? null : !!r.is_overdue,
        marked_paid_at: r.marked_paid_at,
      } : null,
      status: latest?.status ?? "no_statement",
      paid_how: latest?.paid_how ?? null,
      attention: latest?.attention ?? false,
      days_left: latest?.days_left ?? null,
      reason: latest?.status === "unknown" ? (health?.message ?? "This bank's transactions aren't up to date.") : null,
      history: (history.get(r.account_id) ?? []).slice(1),           // the latest is shown above
    };
  });
  // Banks with credit cards, for turning statement details on or off.
  const seen = new Map<number, { item_id: number; bank: string | null; owner: string; statements: string }>();
  for (const c of cards) if (!seen.has(c.item_id)) seen.set(c.item_id, { item_id: c.item_id, bank: c.bank, owner: c.owner, statements: c.statements.status });
  // Bills the household added (part 2), with the same status and attention rule.
  const own = (await listBills(env)).map((b) => {
    const matched = b.matched ? JSON.parse(b.matched) as { id: number; date: string; amount_cents: number; name: string } : null;
    return { ...b, matched, paid_how: b.paid_at ? "marked" : matched ? "matched" : null, ...billStatus({ ...b, matched }, today, ATTENTION_DAYS) };
  });
  return json({ today, attention_days: ATTENTION_DAYS, cards, banks: [...seen.values()], bills: own });
}

async function objectBody(request: Request): Promise<Record<string, unknown>> {
  let b: unknown;
  try { b = await jsonBody(request); } catch (e) {
    if (e instanceof HttpError) throw e;
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) throw unprocessable("body must be a JSON object");
  return b as Record<string, unknown>;
}

/** POST /link/statements/complete {session_id}: after Plaid Link's update mode. Link's onSuccess is
 * only a hint, so Plaid's /item/get must list liabilities among the consented products before
 * statement details are turned on. Only this login's live statements session, claimed once. */
export async function completeStatements(env: Env, config: Config, request: Request, email: string): Promise<Response> {
  const sessionId = (await objectBody(request)).session_id;
  if (typeof sessionId !== "string" || !sessionId) throw unprocessable("session_id is required");
  const valid = `id = ?1 AND email = ?2 AND operation = 'update' AND purpose = 'statements'
                 AND used_at IS NULL AND released_at IS NULL AND expires_at > ${NOW}`;
  const session = await env.DB.prepare(`SELECT item_id FROM link_sessions WHERE ${valid}`).bind(sessionId, email).first<{ item_id: number }>();
  if (!session) throw new HttpError(409, "This statement connection expired or was already finished. Start it again.");
  const item = await env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(session.item_id).first<ItemRow>();
  if (!item) throw new HttpError(404, "bank not found");
  if (!env.TOKEN_ENC_KEY || !config.accountOwner.has(item.plaid_account) || !isConfigured(env, config, item.plaid_account)) {
    throw new HttpError(409, "This bank's Plaid keys aren't set up. Check Setup checks, then try again.");
  }
  let accessToken: string;
  try {
    accessToken = await openAccessToken(env, item);
  } catch (e) {
    if (!(e instanceof FernetError)) throw e;
    throw new HttpError(409, "This bank's stored token can't be decrypted with TOKEN_ENC_KEY (or TOKEN_ENC_KEY_PREVIOUS); link it again instead.");
  }
  const got = await plaidPost<{ item?: { consented_products?: string[]; products?: string[] } }>(
    env, credsFor(env, config, item.plaid_account), "/item/get", { access_token: accessToken });
  const products = [...(got.body.item?.consented_products ?? []), ...(got.body.item?.products ?? [])];
  if (!products.includes("liabilities")) {
    throw new HttpError(409, "Plaid hasn't confirmed access to statement details for this bank. Finish the bank's consent step, then try again.");
  }
  const [, claimed] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO statement_sync (item_id, status, next_attempt_at)
                    SELECT item_id, 'pending', ${NOW} FROM link_sessions WHERE ${valid}
                    ON CONFLICT (item_id) DO UPDATE SET status = 'pending', next_attempt_at = ${NOW}, last_error = NULL`).bind(sessionId, email),
    env.DB.prepare(`UPDATE link_sessions SET used_at = ${NOW}, finished_at = ${NOW} WHERE ${valid} RETURNING item_id`).bind(sessionId, email),
  ]);
  if (!claimed.results.length) throw new HttpError(409, "This statement connection was already finished.");
  return json({ item_id: item.id, statements: "pending" });
}

/** GET /statements: the banks that have credit cards, and whether statement details are on for
 * each (off, pending, ready, consent_required, unsupported, error). For the connect page's list;
 * one row per bank, so it never reads transactions. */
export async function statementBanks(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT i.id AS item_id, i.institution_name AS bank, i.owner, coalesce(ss.status, 'off') AS statements,
            ss.synced_at, ss.last_error
     FROM items i LEFT JOIN statement_sync ss ON ss.item_id = i.id
     WHERE i.source='plaid' AND EXISTS (SELECT 1 FROM accounts a WHERE a.item_id = i.id AND a.type = 'credit')
     ORDER BY i.owner, i.id`).all();
  return json(results);
}

/** POST /statements/paid {account_id, issue_date, paid}: mark a card statement paid by hand (or
 * take the mark off), for one Minty can't reconcile from transactions alone. */
export async function markStatementPaid(env: Env, request: Request): Promise<Response> {
  const b = await objectBody(request);
  if (!Number.isInteger(b.account_id)) throw unprocessable("account_id must be an integer");
  if (typeof b.issue_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.issue_date)) throw unprocessable("issue_date must be a date (YYYY-MM-DD)");
  if (typeof b.paid !== "boolean") throw unprocessable("paid must be true or false");
  const r = await env.DB.prepare(`UPDATE card_statements SET marked_paid_at = ${b.paid ? NOW : "NULL"} WHERE account_id = ? AND issue_date = ? RETURNING marked_paid_at`)
    .bind(b.account_id, b.issue_date).first<{ marked_paid_at: string | null }>();
  if (!r) throw new HttpError(404, "statement not found");
  return json({ account_id: b.account_id, issue_date: b.issue_date, marked_paid_at: r.marked_paid_at });
}

/** POST /statements/off {item_id}: stop fetching statement details for a bank. The statements
 * already saved stay; turning it on again needs the bank's consent again only if Plaid asks. */
export async function statementsOff(env: Env, request: Request): Promise<Response> {
  const itemId = (await objectBody(request)).item_id;
  if (!Number.isInteger(itemId)) throw unprocessable("item_id must be an integer");
  const r = await env.DB.prepare("DELETE FROM statement_sync WHERE item_id = ? RETURNING item_id").bind(itemId).first();
  return json({ item_id: itemId, statements: "off", changed: !!r });
}
