import type { Env } from "../env";
import type { Config } from "../config";
import { HttpError, json, jsonBody, unprocessable } from "../http";
import { fingerprint, merchant, suggest, summarize, type Settings, type Transaction, type Review, type Rule, type Settlement, type Classification } from "../household";
const MAX_ROWS = 5000;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const classifications = new Set(["personal","household","churning","exclude","unreviewed"]);
function month(v: unknown): string { if (typeof v !== "string" || !/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(v)) throw unprocessable("Choose a valid month (YYYY-MM)"); return v; }
function currency(v: unknown): string { if (typeof v !== "string" || !/^[A-Z]{3}$/.test(v)) throw unprocessable("Choose a three-letter currency"); return v; }
function integer(v: unknown, min: number, max: number, label: string): number { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw unprocessable(label); return v; }
function text(v: unknown, max: number): string { if (typeof v !== "string" || v.length > max) throw unprocessable(`Text must be at most ${max} characters`); return v.trim(); }
async function body(request: Request): Promise<Record<string,unknown>> { const b = await jsonBody(request); if (!b || typeof b !== "object" || Array.isArray(b)) throw unprocessable("Expected an object"); return b as Record<string,unknown>; }
export async function getSettings(env: Env, config: Config): Promise<Settings> {
 return await env.DB.prepare("SELECT * FROM household_settings WHERE id=1").first<Settings>() ?? { a_owner: [...config.users.keys()][0], b_owner: null, a_label: "You", b_label: "P2", a_weight: 1, b_weight: 1, revision: 0 };
}
export async function list(env: Env, config: Config, url: URL): Promise<Response> {
 const m = month(url.searchParams.get("month")); const c = currency(url.searchParams.get("currency") || "USD");
 const next = new Date(`${m}-01T00:00:00Z`); next.setUTCMonth(next.getUTCMonth()+1); const end = next.toISOString().slice(0,10);
 const settings = await getSettings(env,config);
 const rows = (await env.DB.prepare(`SELECT t.*, coalesce(a.display_name,a.name,'Account') AS account_name, i.institution_name AS bank
 FROM transactions t JOIN accounts a ON a.id=t.account_id JOIN items i ON i.id=a.item_id
 WHERE t.date>=? AND t.date<? AND t.currency=? AND a.type!='investment'
 ORDER BY t.date DESC,t.id DESC LIMIT ?`).bind(m+"-01",end,c,MAX_ROWS+1).all<Transaction>()).results;
 const truncated = rows.length > MAX_ROWS; if (truncated) rows.length=MAX_ROWS;
 const ids = JSON.stringify(rows.map(t => t.id));
 const reviews = (await env.DB.prepare("SELECT * FROM household_reviews WHERE transaction_id IN (SELECT value FROM json_each(?))").bind(ids).all<Review>()).results;
 const rules = (await env.DB.prepare("SELECT * FROM household_rules ORDER BY id DESC LIMIT 501").all<Rule>()).results;
 const settlements = (await env.DB.prepare("SELECT * FROM household_settlements WHERE month=? AND currency=? ORDER BY date DESC,id LIMIT 1001").bind(m,c).all<Settlement>()).results;
 const history = (await env.DB.prepare("SELECT institution_name AS bank,status,last_error,CASE WHEN sync_start_cursor IS NULL THEN 0 ELSE 1 END AS catching_up FROM items WHERE products!='investments' LIMIT 101").all()).results;
 const mapped = new Map(reviews.map(r => [r.transaction_id,r]));
 return json({ month:m,currency:c,settings,people:[...config.users].map(([key,label]) => ({key,label})),truncated,
 summary: truncated || settlements.length>1000 ? null : summarize(rows,reviews,settlements),rules,settlements,history,
 rows: rows.map(t => ({...t,fingerprint:fingerprint(t),review:mapped.get(t.id) ?? null,
 stale:!!mapped.get(t.id) && mapped.get(t.id)!.fingerprint!==fingerprint(t),suggestion:suggest(t,rules),
 suggested_payer:t.owner===settings.a_owner ? "a" : t.owner===settings.b_owner ? "b" : null})) });
}
export async function saveSettings(env: Env, config: Config, request: Request, email: string): Promise<Response> {
 const b = await body(request); const a = text(b.a_owner,24); const other = b.b_owner===null ? null : text(b.b_owner,24);
 if (!config.users.has(a) || other!==null && (!config.users.has(other) || a===other)) throw unprocessable("Map each participant to a different configured person, or leave P2 unlinked");
 const aLabel=text(b.a_label,40), bLabel=text(b.b_label,40); if (!aLabel || !bLabel) throw unprocessable("Both names are required");
 const aw=integer(b.a_weight,1,1000,"Shares must be whole numbers from 1 to 1000"), bw=integer(b.b_weight,1,1000,"Shares must be whole numbers from 1 to 1000");
 const revision=integer(b.revision,0,1e9,"Invalid settings revision");
 const detail=JSON.stringify({a_owner:a,b_owner:other,a_label:aLabel,b_label:bLabel,a_weight:aw,b_weight:bw});
 const result=await env.DB.batch([
 env.DB.prepare(`INSERT INTO household_settings(id,a_owner,b_owner,a_label,b_label,a_weight,b_weight) SELECT 1,?,?,?,?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM household_settings WHERE id=1)
 ON CONFLICT(id) DO UPDATE SET a_owner=excluded.a_owner,b_owner=excluded.b_owner,a_label=excluded.a_label,b_label=excluded.b_label,a_weight=excluded.a_weight,b_weight=excluded.b_weight,revision=household_settings.revision+1 WHERE household_settings.revision=? RETURNING revision`).bind(a,other,aLabel,bLabel,aw,bw,revision,revision),
 env.DB.prepare("INSERT INTO household_audit(entity,entity_id,action,detail,actor) SELECT 'settings','1','save',?,? WHERE changes()=1").bind(detail,email)]);
 if (!result[0].results.length) throw new HttpError(409,"Settings changed in another tab. Reload before saving."); return json({ok:true});
}
export async function review(env: Env, config: Config, request: Request, email: string, id: number): Promise<Response> {
 const b=await body(request); const t=await env.DB.prepare("SELECT * FROM transactions WHERE id=?").bind(id).first<Transaction>();
 if (!t) throw new HttpError(404,"Transaction no longer exists");
 if (t.pending) throw unprocessable("Wait until this transaction posts before confirming it");
 if (b.fingerprint!==fingerprint(t)) throw new HttpError(409,"The bank transaction changed. Reload and review the current amount.");
 if (typeof b.classification!=="string" || !classifications.has(b.classification)) throw unprocessable("Choose a classification");
 const classification=b.classification as Classification;
 const settings=await getSettings(env,config);
 if (classification==="household" && !settings.revision) throw unprocessable("Save your household split first");
 const shared=classification==="household" ? integer(b.shared_cents,0,Math.abs(t.amount_cents ?? 0),"Shared portion must be between zero and the transaction amount") : null;
 const payer=classification==="household" ? b.payer : null;
 if (classification==="household" && (payer!=="a" && payer!=="b" || !t.currency || !Number.isSafeInteger(t.amount_cents))) throw unprocessable("Confirm who paid and use a transaction with a valid amount and currency");
 const aw=classification==="household" ? integer(b.a_weight,1,1000,"Invalid share") : null;
 const bw=classification==="household" ? integer(b.b_weight,1,1000,"Invalid share") : null;
 const revision=integer(b.revision,0,1e9,"Invalid review revision"); const note=text(b.note ?? "",300);
 const detail=JSON.stringify({classification,shared_cents:shared,payer,a_weight:aw,b_weight:bw,note,fingerprint:b.fingerprint});
 const results=await env.DB.batch([
 env.DB.prepare(`INSERT INTO household_reviews(transaction_id,fingerprint,classification,shared_cents,payer,a_weight,b_weight,note,reviewed_by)
 SELECT ?,?,?,?,?,?,?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM household_reviews WHERE transaction_id=?)
 ON CONFLICT(transaction_id) DO UPDATE SET fingerprint=excluded.fingerprint,classification=excluded.classification,shared_cents=excluded.shared_cents,payer=excluded.payer,a_weight=excluded.a_weight,b_weight=excluded.b_weight,note=excluded.note,reviewed_by=excluded.reviewed_by,revision=household_reviews.revision+1,updated_at=${NOW}
 WHERE household_reviews.revision=? RETURNING revision`).bind(id,fingerprint(t),classification,shared,payer,aw,bw,note,email,revision,id,revision),
 env.DB.prepare("INSERT INTO household_audit(entity,entity_id,action,detail,actor) SELECT 'review',?,'save',?,? WHERE changes()=1").bind(String(id),detail,email)]);
 if (!results[0].results.length) throw new HttpError(409,"This review changed in another tab. Reload before saving.");
 return json({ok:true});
}
export async function saveRule(env: Env, request: Request, email: string): Promise<Response> {
 const b=await body(request); const id=integer(b.transaction_id,1,Number.MAX_SAFE_INTEGER,"Choose a transaction");
 const t=await env.DB.prepare("SELECT * FROM transactions WHERE id=?").bind(id).first<Transaction>();
 const r=await env.DB.prepare("SELECT * FROM household_reviews WHERE transaction_id=?").bind(id).first<Review>();
 if (!t || !r || r.fingerprint!==fingerprint(t) || t.pending || r.classification==="unreviewed" || !merchant(t) || !t.currency || !t.amount_cents) throw unprocessable("Confirm a current posted transaction before remembering its classification");
 const count=await env.DB.prepare("SELECT count(*) AS n FROM household_rules").first<{n:number}>();
 if (count!.n>=500) throw unprocessable("Remove an old rule before adding another (500 maximum)");
 await env.DB.batch([
 env.DB.prepare(`INSERT INTO household_rules(merchant,account_id,currency,direction,classification,created_by) VALUES (?,?,?,?,?,?) ON CONFLICT(merchant,account_id,currency,direction) DO UPDATE SET classification=excluded.classification,created_by=excluded.created_by`).bind(merchant(t),t.account_id,t.currency,Math.sign(t.amount_cents),r.classification,email),
 env.DB.prepare("INSERT INTO household_audit(entity,entity_id,action,detail,actor) VALUES('rule',?,'save',?,?)").bind(String(id),JSON.stringify({merchant:merchant(t),classification:r.classification}),email)]);
 return json({ok:true});
}
export async function deleteRule(env: Env, id: number, email: string): Promise<Response> {
 await env.DB.batch([env.DB.prepare("DELETE FROM household_rules WHERE id=?").bind(id),env.DB.prepare("INSERT INTO household_audit(entity,entity_id,action,detail,actor) SELECT 'rule',?,'delete','{}',? WHERE changes()=1").bind(String(id),email)]);return json({ok:true});
}
export async function settle(env: Env, request: Request, email: string): Promise<Response> {
 const b=await body(request); const id=text(b.id,64); if (!/^[a-zA-Z0-9-]{16,64}$/.test(id)) throw unprocessable("Invalid reimbursement identifier");
 const m=month(b.month),c=currency(b.currency);const d=text(b.date,10);
 if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d)) || new Date(d).toISOString().slice(0,10)!==d) throw unprocessable("Choose a valid payment date");
 if (b.from_person!=="a" && b.from_person!=="b") throw unprocessable("Choose who sent the reimbursement");
 const amount=integer(b.amount_cents,1,100_000_000,"Enter a positive reimbursement amount up to 1,000,000");const note=text(b.note ?? "",200);
 const results=await env.DB.batch([
 env.DB.prepare("INSERT INTO household_settlements(id,month,date,currency,from_person,amount_cents,note,created_by) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING RETURNING id").bind(id,m,d,c,b.from_person,amount,note,email),
 env.DB.prepare("INSERT INTO household_audit(entity,entity_id,action,detail,actor) SELECT 'settlement',?,'record',?,? WHERE changes()=1").bind(id,JSON.stringify({month:m,date:d,currency:c,from_person:b.from_person,amount_cents:amount,note}),email)]);
 if (!results[0].results.length) {
 const old=await env.DB.prepare("SELECT * FROM household_settlements WHERE id=?").bind(id).first<Settlement>();
 if (!old || old.month!==m || old.date!==d || old.currency!==c || old.from_person!==b.from_person || old.amount_cents!==amount || old.note!==note || old.voided_at) throw new HttpError(409,"This payment identifier was already used for a different reimbursement");
 }
 return json({ok:true});
}
export async function voidSettlement(env: Env,id: string,email: string): Promise<Response> {
 await env.DB.batch([env.DB.prepare(`UPDATE household_settlements SET voided_at=${NOW} WHERE id=? AND voided_at IS NULL`).bind(id),env.DB.prepare("INSERT INTO household_audit(entity,entity_id,action,detail,actor) SELECT 'settlement',?,'void','{}',? WHERE changes()=1").bind(id,email)]);return json({ok:true});
}
