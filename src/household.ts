/** Household review uses integer cents; suggestions never create debt. */
export type Classification = "personal" | "household" | "churning" | "exclude" | "unreviewed";
export type Party = "a" | "b";
export interface Settings { a_owner: string; b_owner: string | null; a_label: string; b_label: string; a_weight: number; b_weight: number; revision: number }
export interface Transaction {
 id: number; owner: string; account_id: number; amount_cents: number | null; currency: string | null;
 date: string; name: string | null; merchant_name: string | null; category: string | null; pending: number;
 account_name?: string; bank?: string;
}
export interface Review {
 transaction_id: number; fingerprint: string; classification: Classification; shared_cents: number | null;
 payer: Party | null; a_weight: number | null; b_weight: number | null; note: string; revision: number;
}
export interface Rule { id: number; merchant: string; account_id: number; currency: string; direction: number; classification: Exclude<Classification,"unreviewed"> }
export interface Settlement { id: string; month: string; date: string; currency: string; from_person: Party; amount_cents: number; note: string; voided_at: string | null }
export function fingerprint(t: Transaction): string { return JSON.stringify([t.id,t.owner,t.account_id,t.amount_cents,t.currency,t.date,t.pending]); }
export function merchant(t: Transaction): string { return (t.merchant_name || t.name || "").trim().replace(/\s+/g," ").toLocaleLowerCase(); }
export function suggest(t: Transaction, rules: Rule[]): { classification: Classification; reason: string; source: string } {
 const matched = rules.find(r => r.merchant === merchant(t) && r.account_id === t.account_id && r.currency === t.currency && r.direction === Math.sign(t.amount_cents ?? 0));
 if (matched) return { classification: matched.classification, reason: "Your saved suggestion for this merchant, account and direction.", source: "rule" };
 const category = (t.category || "").toUpperCase();
 const name = merchant(t);
 if (/^(TRANSFER_IN|TRANSFER_OUT|LOAN_PAYMENTS|INCOME)(_|$)/.test(category) || /\b(payment received|payment thank you|autopay payment|credit card payment)\b/.test(name))
  return { classification: "exclude", reason: "Looks like income, a transfer or a debt payment; review before excluding.", source: "category" };
 if ((t.amount_cents ?? 0) < 0) return { classification: "unreviewed", reason: "Money in: check whether this is a purchase refund, statement credit, income or reimbursement.", source: "direction" };
 if (/^(RENT_AND_UTILITIES)(_|$)/.test(category) || /\b(whole foods|trader joe'?s|aldi|grocery|groceries|electric utility|water utility)\b/.test(name))
  return { classification: "household", reason: "Looks like groceries, housing or utilities. Confirm who benefited and any personal portion.", source: "category" };
 return { classification: "unreviewed", reason: "Merchant data alone cannot tell who benefited from this purchase.", source: "unknown" };
}
export function splitCents(signed: number, aWeight: number, bWeight: number): [number,number] {
 if (!Number.isSafeInteger(signed) || !Number.isInteger(aWeight) || !Number.isInteger(bWeight) || aWeight < 1 || bWeight < 1 || aWeight > 1000 || bWeight > 1000) throw new Error("Invalid household split");
 // Round absolute values, then restore sign: a full refund reverses every cent.
 const magnitude = BigInt(Math.abs(signed)); const denominator = BigInt(aWeight + bWeight);
 const a = Number((magnitude * BigInt(aWeight) * 2n + denominator) / (2n * denominator)) * Math.sign(signed);
 return [a, signed - a];
}
export function summarize(rows: Transaction[], reviews: Review[], settlements: Settlement[]) {
 const saved = new Map(reviews.map(r => [r.transaction_id,r]));
 const result = { household_cents: 0, personal_cents: 0, churning_cents: 0, a_share_cents: 0, b_share_cents: 0, owed_to_a_cents: 0, reviewed: 0, needs_review: 0, pending: 0, stale: 0 };
 for (const t of rows) {
  if (t.pending) { result.pending++; continue; }
  const r = saved.get(t.id);
  if (!r || r.classification === "unreviewed") { result.needs_review++; continue; }
  if (r.fingerprint !== fingerprint(t)) { result.stale++; result.needs_review++; continue; }
  result.reviewed++;
  if (r.classification === "personal") result.personal_cents += t.amount_cents ?? 0;
  if (r.classification === "churning") result.churning_cents += t.amount_cents ?? 0;
  if (r.classification !== "household") continue;
  if (!Number.isSafeInteger(t.amount_cents) || !Number.isSafeInteger(r.shared_cents) || r.shared_cents! < 0 || r.shared_cents! > Math.abs(t.amount_cents!) || !r.payer || !r.a_weight || !r.b_weight) { result.stale++; result.needs_review++; result.reviewed--; continue; }
  const shared = r.shared_cents! * Math.sign(t.amount_cents!);
  result.personal_cents += t.amount_cents! - shared;
  const [a,b] = splitCents(shared,r.a_weight,r.b_weight);
  result.household_cents += shared; result.a_share_cents += a; result.b_share_cents += b;
  result.owed_to_a_cents += (r.payer === "a" ? shared : 0) - a;
 }
 for (const s of settlements) if (!s.voided_at) result.owed_to_a_cents += s.from_person === "a" ? s.amount_cents : -s.amount_cents;
 return result;
}
