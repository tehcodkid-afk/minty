import type { Env } from "../env";
import type { Config } from "../config";
import { HttpError, json, jsonBody, unprocessable } from "../http";
import { fingerprint, merchant, suggest, summarize, type Settings, type Transaction, type Review, type Rule, type Settlement, type Classification, splitCents, workflowTags, isSpending } from "../household";
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
 const m=month(url.searchParams.get("month")), c=currency(url.searchParams.get("currency")||"USD");
 const next=new Date(`${m}-01T00:00:00Z`);next.setUTCMonth(next.getUTCMonth()+1);
 const settings=await getSettings(env,config);
 const raw=(await env.DB.prepare(`SELECT t.*,coalesce(a.display_name,a.name,'Account') AS account_name,a.mask AS account_mask,i.institution_name AS bank,
 (SELECT json_group_array(tag) FROM (SELECT tag FROM transaction_tags tt WHERE tt.transaction_id=t.id ORDER BY position)) AS tags
 FROM transactions t JOIN accounts a ON a.id=t.account_id JOIN items i ON i.id=a.item_id
 WHERE t.date>=? AND t.date<? AND t.currency=? AND a.type!='investment' ORDER BY t.date DESC,t.id DESC LIMIT ?`)
 .bind(m+"-01",next.toISOString().slice(0,10),c,MAX_ROWS+1).all<Transaction & {tags:string}>()).results;
 const truncated=raw.length>MAX_ROWS;if(truncated)raw.length=MAX_ROWS;
 const rows=raw.map(t=>({...t,tags:JSON.parse(t.tags) as string[]}));
 const ids=JSON.stringify(rows.map(t=>t.id));
 const reviews=(await env.DB.prepare("SELECT * FROM household_reviews WHERE transaction_id IN (SELECT value FROM json_each(?))").bind(ids).all<Review>()).results;
 const rules=(await env.DB.prepare("SELECT * FROM household_rules ORDER BY id DESC LIMIT 501").all<Rule>()).results;
 const settlements=(await env.DB.prepare("SELECT * FROM household_settlements WHERE month=? AND currency=? ORDER BY date DESC,id LIMIT 1001").bind(m,c).all<Settlement>()).results;
 const history=(await env.DB.prepare("SELECT institution_name AS bank,status,last_error,CASE WHEN sync_start_cursor IS NOT NULL OR (source='lunchmoney' AND txn_cursor IS NULL) THEN 1 ELSE 0 END AS catching_up FROM items WHERE products!='investments' LIMIT 101").all()).results;
 const accounts=(await env.DB.prepare(`SELECT a.id,coalesce(a.display_name,a.name,'Account') AS name,a.mask,a.owner,a.purpose,i.institution_name AS bank,
 EXISTS(SELECT 1 FROM household_accounts h WHERE h.account_id=a.id) AS household FROM accounts a JOIN items i ON i.id=a.item_id WHERE a.type!='investment' ORDER BY a.owner,i.institution_name,a.name LIMIT 501`).all<{id:number;household:number;purpose:string}>()).results;
 const selected=new Set(accounts.filter(a=>a.household).map(a=>a.id));
 const entries=(await env.DB.prepare("SELECT * FROM household_entries WHERE month=? AND currency=? ORDER BY name LIMIT 1001").bind(m,c).all<ManualEntry>()).results;
 const recurring=(await env.DB.prepare("SELECT * FROM household_recurring WHERE active=1 AND currency=? ORDER BY name LIMIT 501").bind(c).all<ManualEntry & {start_month:string}>()).results;
 const categories=(await env.DB.prepare("SELECT merchant,category,source FROM merchant_categories LIMIT 5001").all<{merchant:string;category:string;source:string}>()).results;
 const categoriesByName=new Map(categories.map(r=>[r.merchant,r]));
 const mapped=new Map(reviews.map(r=>[r.transaction_id,r]));
 const household=rows.filter(t=>selected.has(t.account_id)&&t.tags.some(tag=>tag.toLowerCase()==="household")&&!t.tags.some(tag=>/^(sweeps|debit|gold)$/i.test(tag)));
 const summary=truncated||settlements.length>1000||entries.length>1000?null:summarize(household,reviews,settlements);
 if(summary) for(const e of entries.filter(e=>!e.voided_at)) {
  const [a,b]=splitCents(e.amount_cents,e.a_weight,e.b_weight);
  summary.household_cents+=e.amount_cents;summary.a_share_cents+=a;summary.b_share_cents+=b;
  summary.owed_to_a_cents+=(e.payer==="a"?e.amount_cents:0)-a;
 }
 const personalAccounts=new Set(accounts.filter(a=>a.purpose==='personal').map(a=>a.id));
 const personal=[...config.users].map(([owner,label])=>({owner,label,amount_cents:truncated?null:rows.filter(t=>t.owner===owner&&personalAccounts.has(t.account_id)&&workflowTags(t.tags).length===0&&isSpending(t)).reduce((n,t)=>n+(t.amount_cents||0),0)}));
 const view=url.searchParams.get("view")||"household";
 const output=view==="tagging"?rows:view==="candidates"?rows.filter(t=>selected.has(t.account_id)&&workflowTags(t.tags).length===0&&isSpending(t)):household;
 return json({month:m,currency:c,settings,people:[...config.users].map(([key,label])=>({key,label})),truncated,summary,personal,unassigned_accounts:accounts.filter(a=>a.purpose==='unassigned').length,rules,settlements,history,accounts,entries,recurring,
 rows:output.map(t=>({...t,fingerprint:fingerprint(t),review:mapped.get(t.id)??null,eligible:selected.has(t.account_id),spending:isSpending(t),
 stale:!!mapped.get(t.id)&&mapped.get(t.id)!.fingerprint!==fingerprint(t),suggestion:suggest(t,rules),merchant_category:categoriesByName.get(merchant(t))??null,
 suggested_payer:t.owner===settings.a_owner?"a":t.owner===settings.b_owner?"b":null}))});
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
 const oldTags=(await env.DB.prepare("SELECT tag FROM transaction_tags WHERE transaction_id=? ORDER BY position").bind(id).all<{tag:string}>()).results.map(x=>x.tag);
 let tags:string[];
 if(b.tags!==undefined){
  if(!Array.isArray(b.tags)||b.tags.length>50||!b.tags.every(v=>typeof v==="string"&&v.trim().length>0&&v.length<=64))throw unprocessable("Invalid tags");
  tags=b.tags.map(v=>(v as string).trim());
  if(new Set(tags.map(t=>t.toLowerCase())).size!==tags.length)throw unprocessable("Duplicate tags");
  if(JSON.stringify(b.expected_tags)!==JSON.stringify(oldTags))throw new HttpError(409,"Tags changed in another tab. Reload before tagging.");
 }else tags=oldTags.filter(t=>t.toLowerCase()!=="household");
 if(classification==="household"){
  if(tags.some(t=>/^(sweeps|debit|gold)$/i.test(t)))throw unprocessable("Remove Sweeps, Debit or Gold before tagging Household");
  if(!tags.some(t=>t.toLowerCase()==="household"))tags.push("Household");
  if(!oldTags.some(t=>t.toLowerCase()==="household")&&!await env.DB.prepare("SELECT 1 FROM household_accounts WHERE account_id=?").bind(t.account_id).first())throw unprocessable("Select this card as a household card first");
 }else tags=tags.filter(t=>t.toLowerCase()!=="household");
 if(tags.length>50)throw unprocessable("Too many tags");
 const detail=JSON.stringify({classification,shared_cents:shared,payer,a_weight:aw,b_weight:bw,note,fingerprint:b.fingerprint,tags,operation:crypto.randomUUID()});
 const guard="EXISTS(SELECT 1 FROM household_audit WHERE entity='review' AND entity_id=? AND detail=?)";
 const results=await env.DB.batch([
 env.DB.prepare(`INSERT INTO household_reviews(transaction_id,fingerprint,classification,shared_cents,payer,a_weight,b_weight,note,reviewed_by)
 SELECT ?,?,?,?,?,?,?,?,? FROM transactions source WHERE source.id=? AND source.amount_cents IS ? AND source.date=? AND source.pending=0 AND source.currency IS ? AND source.account_id=? AND source.owner=?
 AND (SELECT json_group_array(tag) FROM (SELECT tag FROM transaction_tags WHERE transaction_id=source.id ORDER BY position))=?
 AND (?=0 OR EXISTS(SELECT 1 FROM household_reviews WHERE transaction_id=?))
 ON CONFLICT(transaction_id) DO UPDATE SET fingerprint=excluded.fingerprint,classification=excluded.classification,shared_cents=excluded.shared_cents,payer=excluded.payer,a_weight=excluded.a_weight,b_weight=excluded.b_weight,note=excluded.note,reviewed_by=excluded.reviewed_by,revision=household_reviews.revision+1,updated_at=${NOW}
 WHERE household_reviews.revision=? RETURNING revision`).bind(id,fingerprint(t),classification,shared,payer,aw,bw,note,email,id,t.amount_cents,t.date,t.currency,t.account_id,t.owner,JSON.stringify(oldTags),revision,id,revision),
 env.DB.prepare("INSERT INTO household_audit(entity,entity_id,action,detail,actor) SELECT 'review',?,'save',?,? WHERE changes()=1").bind(String(id),detail,email),
 env.DB.prepare(`DELETE FROM transaction_tags WHERE transaction_id=? AND ${guard}`).bind(id,String(id),detail),
 ...tags.map((tag,i)=>env.DB.prepare(`INSERT INTO transaction_tags(transaction_id,tag,position) SELECT ?,?,? WHERE ${guard}`).bind(id,tag,i,String(id),detail))]);
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

interface ManualEntry { id:string; month:string; name:string; currency:string; amount_cents:number; payer:"a"|"b"; a_weight:number; b_weight:number; note:string; recurring_id:string|null; voided_at:string|null }
export async function setAccount(env:Env,request:Request,email:string,id:number):Promise<Response>{
 const b=await body(request);
 const purpose=b.purpose ?? (typeof b.enabled==='boolean' ? (b.enabled?'personal':'unassigned') : null);
 if(!['unassigned','personal','churning'].includes(purpose as string))throw unprocessable("Choose Personal / Household or Churning");
 b.enabled=purpose==='personal';
 if(!await env.DB.prepare("SELECT id FROM accounts WHERE id=? AND type!='investment'").bind(id).first())throw new HttpError(404,"Account not found");
 await env.DB.batch([env.DB.prepare("UPDATE accounts SET purpose=? WHERE id=?").bind(purpose,id),env.DB.prepare(b.enabled?"INSERT INTO household_accounts(account_id) VALUES(?) ON CONFLICT DO NOTHING":"DELETE FROM household_accounts WHERE account_id=?").bind(id),env.DB.prepare("INSERT INTO household_audit(entity,entity_id,action,detail,actor) VALUES('account',?,'select',?,?)").bind(String(id),JSON.stringify(b),email)]);
 return json({ok:true});
}
export async function saveEntry(env:Env,config:Config,request:Request,email:string,recurring=false):Promise<Response>{
 const b=await body(request),id=text(b.id,64);if(!/^[a-zA-Z0-9-]{16,64}$/.test(id))throw unprocessable("Invalid entry identifier");
 const m=month(b.month),c=currency(b.currency),name=text(b.name,120),note=text(b.note??"",300);
 if(!name||b.payer!=="a"&&b.payer!=="b")throw unprocessable("Enter a name and who paid");
 const amount=integer(b.amount_cents,1,100_000_000,"Enter an amount between 0.01 and 1,000,000");
 const settings=await getSettings(env,config);if(!settings.revision)throw unprocessable("Save your household split first");
 const aw=integer(b.a_weight??settings.a_weight,1,1000,"Invalid split"),bw=integer(b.b_weight??settings.b_weight,1,1000,"Invalid split");
 const table=recurring?"household_recurring":"household_entries";
 const old=await env.DB.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(id).first<Record<string,unknown>>();
 const same=(r:Record<string,unknown>)=>r.name===name&&r[recurring?"start_month":"month"]===m&&r.currency===c&&r.amount_cents===amount&&r.payer===b.payer&&r.a_weight===aw&&r.b_weight===bw&&(recurring?!!r.active:r.note===note&&!r.voided_at);
 if(old){if(!same(old))throw new HttpError(409,"This identifier was already used. Reload before adding another entry.");return json({ok:true});}
 const insert=recurring?env.DB.prepare("INSERT INTO household_recurring(id,name,start_month,currency,amount_cents,payer,a_weight,b_weight,created_by) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING").bind(id,name,m,c,amount,b.payer,aw,bw,email)
 :env.DB.prepare("INSERT INTO household_entries(id,name,month,currency,amount_cents,payer,a_weight,b_weight,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING").bind(id,name,m,c,amount,b.payer,aw,bw,note,email);
 await env.DB.batch([insert,
 ...(recurring?[env.DB.prepare("INSERT INTO household_entries(id,month,name,currency,amount_cents,payer,a_weight,b_weight,note,recurring_id,created_by) SELECT id||'-'||?, ?,name,currency,amount_cents,payer,a_weight,b_weight,?,id,? FROM household_recurring WHERE id=? ON CONFLICT(recurring_id,month) DO NOTHING").bind(m,m,note,email,id)]:[]),env.DB.prepare("INSERT INTO household_audit(entity,entity_id,action,detail,actor) SELECT ?,?,'create',?,? WHERE changes()=1").bind(recurring?"recurring":"entry",id,JSON.stringify({name,month:m,amount_cents:amount,payer:b.payer}),email)]);
 const saved=await env.DB.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(id).first<Record<string,unknown>>();
 if(!saved||!same(saved))throw new HttpError(409,"This identifier was already used. Reload before adding another entry.");
 return json({ok:true});
}
export async function materialize(env:Env,request:Request,email:string):Promise<Response>{
 const b=await body(request),m=month(b.month),c=currency(b.currency);
 await env.DB.batch([env.DB.prepare(`INSERT INTO household_entries(id,month,name,currency,amount_cents,payer,a_weight,b_weight,note,recurring_id,created_by)
 SELECT id||'-'||?, ?,name,currency,amount_cents,payer,a_weight,b_weight,'Monthly recurring entry',id,? FROM household_recurring
 WHERE active=1 AND start_month<=? AND currency=? ON CONFLICT(recurring_id,month) DO NOTHING`).bind(m,m,email,m,c),
 env.DB.prepare("INSERT INTO household_audit(entity,entity_id,action,detail,actor) SELECT 'entries',?,'add-recurring',?,? WHERE changes()>0").bind(m,JSON.stringify({currency:c}),email)]);return json({ok:true});
}
export async function removeEntry(env:Env,id:string,email:string,recurring=false):Promise<Response>{
 await env.DB.batch([env.DB.prepare(recurring?"UPDATE household_recurring SET active=0 WHERE id=? AND active=1":`UPDATE household_entries SET voided_at=${NOW} WHERE id=? AND voided_at IS NULL`).bind(id),
 env.DB.prepare("INSERT INTO household_audit(entity,entity_id,action,detail,actor) SELECT ?,?,'void','{}',? WHERE changes()=1").bind(recurring?"recurring":"entry",id,email)]);return json({ok:true});
}
