import type { Env } from "./env";
import type { Config } from "./config";
import { loadConfig } from "./config";
import { HttpError, json, jsonBody, unprocessable } from "./http";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const API = "https://api.lunchmoney.dev/v2";
const PAGE = 100;
export const LUNCH_MONEY_CRON = "*/2 * * * *";
type Obj = Record<string, any>;
type Selection = { remote_id:number; owner:string; target_id:number|null; start_date:string; name:string; mask:string|null; type:string; subtype:string|null; currency:string; balance:number; bank:string; expected_id:string|null; previous_owner:string|null; pending:number; source_status:string; source_updated_at:string|null };
function token(env:Env):string {
 if(typeof env.LUNCH_MONEY_TOKEN!=="string"||!env.LUNCH_MONEY_TOKEN.trim()) throw new HttpError(409,"Add the LUNCH_MONEY_TOKEN secret in Cloudflare first.");
 return env.LUNCH_MONEY_TOKEN.trim();
}
async function get(env:Env,path:string,allowMissing=false):Promise<Obj> {
 let response:Response;
 try { response=await fetch(API+path,{headers:{Authorization:"Bearer "+token(env),Accept:"application/json"},redirect:"error",signal:AbortSignal.timeout(20000)}); }
 catch(e) { if(e instanceof HttpError)throw e; throw new HttpError(502,"Lunch Money could not be reached. Existing records were retained."); }
 if(allowMissing&&response.status===404)return {missing:true};
 if(!response.ok)throw new HttpError(502,`Lunch Money returned HTTP ${response.status}. Check its connection and API token.`);
 // Do not expose upstream bodies, URLs with credentials, or tokens through errors/logs.
 const text=await response.text();
 if(text.length>2_000_000)throw new HttpError(502,"Lunch Money response exceeded the supported page size.");
 try { const body=JSON.parse(text); if(!body||typeof body!=="object"||Array.isArray(body))throw Error();return body; }
 catch { throw new HttpError(502,"Lunch Money returned an invalid response."); }
}
function numberId(v:unknown):number { if(!Number.isSafeInteger(v)||Number(v)<1)throw unprocessable("Invalid account or transaction ID.");return Number(v); }
function date(v:unknown):string {
 if(typeof v!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v||v<"2000-01-01")throw unprocessable("Choose a valid start date.");
 return v;
}
export function cents(v:unknown):number {
 if(typeof v!=="string"&&typeof v!=="number")throw new HttpError(502,"Lunch Money supplied an invalid amount.");
 if(!/^-?\d+(\.\d{1,8})?$/.test(String(v)))throw new HttpError(502,"Lunch Money supplied an invalid amount.");
 const [whole,fraction=""]=String(v).replace(/^-/, "").split(".");
 const minor=BigInt(whole)*100n+BigInt((fraction+"00").slice(0,2))+(fraction.length>2&&fraction[2]>="5"?1n:0n);
 const n=Number(minor)*(String(v).startsWith("-")?-1:1);
 if(!Number.isSafeInteger(n)||Math.abs(n)>1e14)throw new HttpError(502,"Lunch Money amount is out of range.");
 return n;
}
function str(v:unknown,max=200):string {return typeof v==="string"?v.slice(0,max):"";}
function currency(v:unknown):string { const c=str(v,10).toUpperCase();if(!/^[A-Z]{3}$/.test(c))throw new HttpError(502,"Lunch Money supplied an invalid currency.");return c; }
export function accountType(v:unknown):string {
 const type=str(v).toLowerCase();
 if(type==="cash"||type==="depository")return "depository";
 if(type==="credit")return "credit";
 if(type==="loan"||type==="other liability")return "loan";
 if(type==="investment"||type==="cryptocurrency"||type==="employee compensation")return "investment";
 return "other";
}
async function identity(env:Env):Promise<Obj> {
 const me=await get(env,"/me");numberId(me.account_id);
 const saved=await env.DB.prepare("SELECT budget_id FROM lunch_money_budget WHERE id=1").first<{budget_id:number}>();
 if(saved&&saved.budget_id!==me.account_id)throw new HttpError(409,"This token belongs to a different Lunch Money budget. Keep the original budget to avoid mixing records.");
 return me;
}
async function remoteAccounts(env:Env):Promise<Obj[]> {
 const data=await get(env,"/plaid_accounts");
 if(!Array.isArray(data.plaid_accounts)||data.plaid_accounts.length>500)throw new HttpError(502,"Invalid or oversized Lunch Money account list.");
 return data.plaid_accounts;
}
export async function catalog(env:Env,config:Config):Promise<Response> {
 const configured=typeof env.LUNCH_MONEY_TOKEN==="string"&&!!env.LUNCH_MONEY_TOKEN.trim();
 const selected=(await env.DB.prepare("SELECT l.*,a.owner,a.name,a.mask FROM lunch_money_accounts l JOIN accounts a ON a.id=l.account_id").all()).results;
 const existing=(await env.DB.prepare("SELECT a.id,a.owner,coalesce(a.display_name,a.name) AS name,a.mask,a.type,a.feed,i.institution_name AS bank,(SELECT max(date) FROM transactions t WHERE t.account_id=a.id AND pending=0) AS last_date FROM accounts a JOIN items i ON i.id=a.item_id ORDER BY a.owner,a.name").all()).results;
 if(!configured)return json({configured:false,accounts:[],selected,existing,people:[...config.users].map(([key,label])=>({key,label}))});
 const me=await identity(env);
 const accounts=(await remoteAccounts(env)).map(a=>({id:numberId(a.id),name:str(a.display_name||a.name),mask:str(a.mask)||null,bank:str(a.institution_name),type:str(a.type),currency:currency(a.currency),status:str(a.status),updated_at:a.plaid_last_successful_update||a.last_import||null}));
 return json({configured:true,budget_name:str(me.budget_name),accounts,selected,existing,people:[...config.users].map(([key,label])=>({key,label}))});
}
export async function preview(env:Env,config:Config,request:Request,actor:string):Promise<Response> {
 const b=await jsonBody(request) as Obj;
 if(!b||!Array.isArray(b.selections)||!b.selections.length||b.selections.length>60)throw unprocessable("Select between 1 and 60 accounts.");
 const me=await identity(env),remote=await remoteAccounts(env),out:Selection[]=[],seen=new Set<number>(),targets=new Set<number>();
 for(const row of b.selections) {
  const id=numberId(row.remote_id);
  if(seen.has(id))throw unprocessable("An account was selected twice.");seen.add(id);
  const a=remote.find(a=>a.id===id);if(!a)throw unprocessable("A selected account is no longer available.");
  if(await env.DB.prepare("SELECT 1 FROM lunch_money_accounts WHERE remote_id=?").bind(id).first())throw new HttpError(409,"An account is already imported. Refresh the account list.");
  if(!config.users.has(row.owner))throw unprocessable("Choose a configured Minty player for every account.");
  const start=date(row.start_date);if(start>new Date().toISOString().slice(0,10))throw unprocessable("Start date cannot be in the future.");
  let target:Obj|null=null;
  if(row.target_id!==null&&row.target_id!==undefined) {
   const targetId=numberId(row.target_id);if(targets.has(targetId))throw unprocessable("Two feeds cannot replace the same Minty account.");targets.add(targetId);
   target=await env.DB.prepare("SELECT a.*,(SELECT max(date) FROM transactions t WHERE t.account_id=a.id AND pending=0) AS last_date,(SELECT count(*) FROM transactions t WHERE t.account_id=a.id AND pending=1) AS pending FROM accounts a WHERE id=? AND feed='plaid'").bind(targetId).first<Obj>();
   if(!target)throw new HttpError(409,"That Minty account already uses another feed or no longer exists.");
  } else {
   const possible=await env.DB.prepare("SELECT 1 FROM accounts WHERE mask=? LIMIT 1").bind(str(a.mask)||null).first();
   if(possible&&row.distinct!==true)throw unprocessable("An account with these ending digits already exists. Select it, or confirm this is a distinct card.");
  }
  // Keep posted Plaid history and switch at an explicit day boundary, never fuzzy-merge financial records.
  const cutoff=target?.last_date?new Date(Date.parse(target.last_date)+86400000).toISOString().slice(0,10):start;
  out.push({remote_id:id,owner:row.owner,target_id:target?.id??null,start_date:cutoff,name:str(a.display_name||a.name),mask:str(a.mask)||null,type:accountType(a.type),subtype:str(a.subtype)||null,currency:currency(a.currency),balance:cents(a.balance),bank:str(a.institution_name)||"Lunch Money",expected_id:target?.plaid_account_id??null,previous_owner:target?.owner??null,pending:target?.pending??0,source_status:str(a.status),source_updated_at:a.plaid_last_successful_update||a.last_import||null});
 }
 const id=crypto.randomUUID();
 await env.DB.batch([
 env.DB.prepare("DELETE FROM lunch_money_plans WHERE expires_at < "+NOW),
 env.DB.prepare("INSERT INTO lunch_money_plans(id,actor,budget_id,body,expires_at) VALUES(?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes'))").bind(id,actor,me.account_id,JSON.stringify(out))]);
 return json({plan_id:id,accounts:out,notice:"New accounts import from the chosen date. For replacements, posted Plaid history is retained through its latest date; Lunch Money starts the following day. Pending Plaid rows are replaced. Changing the player also reassigns saved transactions; tags stay, but previous household reviews may need reconfirming. Late changes before the cutoff require separate reconciliation."});
}
export async function apply(env:Env,config:Config,request:Request,actor:string):Promise<Response> {
 const b=await jsonBody(request) as Obj;
 if(typeof b?.plan_id!=="string"||b.confirm!==true)throw unprocessable("Review and confirm an import preview first.");
 const p=await env.DB.prepare("SELECT * FROM lunch_money_plans WHERE id=? AND actor=? AND expires_at>"+NOW).bind(b.plan_id,actor).first<Obj>();
 if(!p)throw new HttpError(409,"This preview expired. Preview the selection again.");
 if(p.applied_at)return json({ok:true,already_applied:true});
 const me=await identity(env);if(me.account_id!==p.budget_id)throw new HttpError(409,"The Lunch Money budget changed. Preview again.");
 const rows=JSON.parse(p.body) as Selection[];
 if(rows.some(r=>!config.users.has(r.owner)))throw new HttpError(409,"Player settings changed. Preview again.");
 const statements:D1PreparedStatement[]=[];
 // Deliberately error inside the transaction if another tab already claimed this preview.
 const assertion=(sql:string,...params:any[])=>env.DB.prepare("SELECT CASE WHEN ("+sql+") THEN 1 ELSE json('stale import preview') END").bind(...params);
 statements.push(assertion("SELECT applied_at IS NULL FROM lunch_money_plans WHERE id=?",p.id));
 statements.push(env.DB.prepare("INSERT INTO lunch_money_budget(id,budget_id) VALUES(1,?) ON CONFLICT(id) DO NOTHING").bind(p.budget_id));
 statements.push(assertion("SELECT budget_id=? FROM lunch_money_budget WHERE id=1",p.budget_id));
 for(const r of rows) {
  const key=`lunchmoney:${p.budget_id}:${r.remote_id}`;
  if(r.target_id!==null) {
   const previousDay=new Date(Date.parse(r.start_date)-86400000).toISOString().slice(0,10);
   statements.push(assertion("SELECT count(*)=1 FROM accounts a WHERE a.id=? AND a.plaid_account_id=? AND a.owner=? AND a.feed='plaid' AND NOT EXISTS(SELECT 1 FROM transactions t WHERE t.account_id=a.id AND pending=0 AND date>?)",r.target_id,r.expected_id,r.previous_owner,previousDay));
   statements.push(env.DB.prepare("DELETE FROM transactions WHERE account_id=? AND pending=1").bind(r.target_id));
   statements.push(env.DB.prepare("UPDATE accounts SET feed='lunchmoney',balance_available_cents=NULL,owner=? WHERE id=?").bind(r.owner,r.target_id));
   if(r.previous_owner!==r.owner){
    statements.push(env.DB.prepare("UPDATE transactions SET owner=? WHERE account_id=?").bind(r.owner,r.target_id));
    statements.push(env.DB.prepare("INSERT INTO household_audit(entity,entity_id,action,detail,actor) VALUES('account',?,'change-player',?,?)").bind(String(r.target_id),JSON.stringify({from:r.previous_owner,to:r.owner,source:"lunchmoney-import"}),actor));
   }
  } else {
   statements.push(env.DB.prepare("INSERT INTO items(owner,plaid_account,plaid_item_id,access_token_enc,institution_name,source,status) VALUES(?,'lunchmoney',?,'',?,'lunchmoney','good')").bind(r.owner,key,r.bank));
   statements.push(env.DB.prepare("INSERT INTO accounts(owner,item_id,plaid_account_id,name,mask,type,subtype,currency,balance_current_cents,feed) SELECT ?,id,?,?,?,?,?,?,?,'lunchmoney' FROM items WHERE plaid_item_id=?").bind(r.owner,key,r.name,r.mask,r.type,r.subtype,r.currency,r.balance,key));
  }
  const accountId=r.target_id!==null?"SELECT id FROM accounts WHERE id=?":"SELECT id FROM accounts WHERE plaid_account_id=?";
  statements.push(env.DB.prepare(`INSERT INTO lunch_money_accounts(remote_id,account_id,start_date,source_status,source_updated_at) VALUES(?,(${accountId}),?,?,?)`).bind(r.remote_id,r.target_id??key,r.start_date,r.source_status,r.source_updated_at));
 }
 statements.push(env.DB.prepare("UPDATE lunch_money_plans SET applied_at="+NOW+" WHERE id=?").bind(p.id));
 statements.push(env.DB.prepare("INSERT INTO app_state(key,value) VALUES('audit_dirty','1') ON CONFLICT(key) DO UPDATE SET value='1'"));
 try {await env.DB.batch(statements);} catch {throw new HttpError(409,"Accounts changed while this preview was open. Refresh and preview again; nothing from this plan was applied.");}
 return json({ok:true,accounts:rows.length});
}
export async function pause(env:Env,request:Request):Promise<Response> {
 const b=await jsonBody(request) as Obj;const id=numberId(b?.remote_id);
 if(typeof b.enabled!=="boolean")throw unprocessable("enabled must be true or false.");
 const results=await env.DB.batch([env.DB.prepare("UPDATE lunch_money_accounts SET enabled=?,next_run='',lease=NULL,lease_until=NULL,offset=0,cycle_end=NULL,cycle_started=NULL,cycle_since=NULL WHERE remote_id=? RETURNING remote_id").bind(b.enabled?1:0,id),env.DB.prepare("DELETE FROM lunch_money_stage WHERE remote_id=?").bind(id)]);
 const r=results[0].results.length;
 if(!r)throw new HttpError(404,"Import account not found.");
 return json({ok:true});
}
type Mapping = {remote_id:number; account_id:number; owner:string; item_id:number; start_date:string; offset:number; cycle_end:string|null; cycle_started:string|null; cycle_since:string|null; cursor:string|null; last_full_sync:string|null};
export function normalizeTransaction(t:Obj,remote:number,categories:Map<number,Obj>):Obj|null {
 if(t.plaid_account_id!==remote||t.is_group_parent||t.split_parent_id)return null;
 numberId(t.id);
 if(t.status==="delete_pending")return null;
 const c=categories.get(t.category_id);
 return {id:t.id,amount_cents:cents(t.amount),currency:currency(t.currency),date:date(t.date),name:str(t.payee),merchant_name:str(t.plaid_metadata?.merchant_name)||str(t.payee),category:c?.is_income?"INCOME":c?.exclude_from_totals?"TRANSFER_OUT":str(t.plaid_metadata?.personal_finance_category?.primary)||str(c?.name)||"OTHER",pending:t.is_pending?1:0,account_owner:str(t.plaid_metadata?.account_owner)||null,body:JSON.stringify(t)};
}
/** One bounded page per call. Staging makes failed/incomplete imports invisible to the ledger. */
export async function syncNext(env:Env):Promise<Obj> {
 if(!env.LUNCH_MONEY_TOKEN)return {configured:false};
 const lease=crypto.randomUUID();
 const claim=await env.DB.prepare(`UPDATE lunch_money_accounts SET lease=?,lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 minutes'),last_attempt=${NOW}
 WHERE remote_id=(SELECT remote_id FROM lunch_money_accounts WHERE enabled=1 AND next_run<=${NOW} AND (lease_until IS NULL OR lease_until<${NOW}) ORDER BY coalesce(last_attempt,''),remote_id LIMIT 1) RETURNING *`).bind(lease).first<Mapping>();
 if(!claim)return {idle:true};
 const id=claim.remote_id;
 const guard="EXISTS(SELECT 1 FROM lunch_money_accounts WHERE remote_id=?1 AND lease=?2 AND enabled=1)";
 const q=(sql:string,...params:any[])=>env.DB.prepare(sql).bind(id,lease,...params);
 try {
  const me=await identity(env);
  const current=await env.DB.prepare("SELECT a.owner,a.item_id FROM accounts a WHERE id=? AND feed='lunchmoney'").bind(claim.account_id).first<{owner:string;item_id:number}>();
  if(!current||!loadConfig(env).users.has(current.owner))throw new HttpError(409,"The mapped player or account is no longer configured.");
  const since=claim.offset>0?claim.cycle_since:claim.cursor&&claim.last_full_sync&&Date.now()-Date.parse(claim.last_full_sync)<7*86400000?claim.cursor:null;
  const started=claim.cycle_started??new Date().toISOString();
  const end=claim.cycle_end??new Date().toISOString().slice(0,10);
  if(claim.start_date>end) {
   await q("UPDATE lunch_money_accounts SET next_run=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'),lease=NULL,lease_until=NULL WHERE remote_id=?1 AND lease=?2").run();
   return {remote_id:id,waiting_for_start:true};
  }
  const cats=await get(env,"/categories?format=flattened");
  if(!Array.isArray(cats.categories))throw new HttpError(502,"Invalid Lunch Money categories.");
  const query=new URLSearchParams({plaid_account_id:String(id),start_date:claim.start_date,end_date:end,include_pending:"true",include_metadata:"true",include_split_parents:"true",include_group_children:"true",limit:String(PAGE),offset:String(claim.offset)});
  if(since)query.set("updated_since",since);
  const response=await get(env,"/transactions?"+query);
  if(!Array.isArray(response.transactions)||typeof response.has_more!=="boolean"||(response.has_more&&!response.transactions.length)||claim.offset>=100000)throw new HttpError(502,"Lunch Money pagination did not complete safely.");
  if(response.transactions.some((t:Obj)=>!t||(!t.is_group_parent&&t.plaid_account_id!==id)))throw new HttpError(502,"Lunch Money returned records for a different account.");
  const categories=new Map<number,Obj>(cats.categories.map((c:Obj)=>[c.id,c]));
  const normalized=response.transactions.map((t:Obj)=>normalizeTransaction(t,id,categories)).filter((t:Obj|null):t is Obj=>t!==null);
  for(const row of normalized)if(row.date<claim.start_date||row.date>end)throw new HttpError(502,"Lunch Money returned a transaction outside the requested dates.");
  const prefix='lunchmoney:'+me.account_id+':';
  const collision=await env.DB.prepare("SELECT 1 FROM transactions WHERE account_id!=? AND plaid_txn_id IN (SELECT ?||(value->>'id') FROM json_each(?)) LIMIT 1").bind(claim.account_id,prefix,JSON.stringify(normalized)).first();
  if(collision)throw new HttpError(409,"A source transaction moved between accounts. Review its mapping before importing.");
  const batch:D1PreparedStatement[]=[];
  if(claim.offset===0)batch.push(q("DELETE FROM lunch_money_stage WHERE remote_id=?1 AND "+guard));
  batch.push(q("INSERT INTO lunch_money_stage(remote_id,transaction_id,body) SELECT ?1,value->>'id',value FROM json_each(?3) WHERE "+guard+" ON CONFLICT(remote_id,transaction_id) DO UPDATE SET body=excluded.body",JSON.stringify(normalized)));
  if(response.has_more) {
   batch.push(q("UPDATE lunch_money_accounts SET offset=offset+?3,cycle_end=?4,cycle_started=?5,cycle_since=?6,lease=NULL,lease_until=NULL,last_error=NULL WHERE remote_id=?1 AND lease=?2",response.transactions.length,end,started,since));
  } else {
   const a=await remoteAccounts(env), account=a.find(a=>a.id===id);
   if(!account)throw new HttpError(502,"The selected account disappeared from Lunch Money. Existing records were retained.");
   // Offset pagination is not a snapshot. Confirm every missing ledger row individually;
   // never interpret a skipped page or a temporarily incomplete listing as a deletion.
   const missing=since?[]:(await env.DB.prepare("SELECT t.plaid_txn_id,r.source_transaction_id FROM transactions t JOIN lunch_money_records r ON r.transaction_id=t.id WHERE r.remote_id=? AND t.date>=? AND t.date<=? AND NOT EXISTS(SELECT 1 FROM lunch_money_stage s WHERE s.remote_id=? AND ?=0 AND s.transaction_id=r.source_transaction_id) AND NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE j.value->>'id'=r.source_transaction_id) LIMIT 11").bind(id,claim.start_date,end,id,claim.offset===0?1:0,JSON.stringify(normalized)).all<{plaid_txn_id:string;source_transaction_id:number}>()).results;
   if(missing.length>10)throw new HttpError(409,"More than ten previously imported transactions are missing. Existing records were retained; review Lunch Money before retrying.");
   const deleted:string[]=[];
   for(const row of missing){
    const live=await get(env,"/transactions/"+row.source_transaction_id,true);
    if(live.missing||live.status==="delete_pending"){deleted.push(row.plaid_txn_id);continue;}
    if(live.plaid_account_id!==id||live.is_group_parent||live.split_parent_id)throw new HttpError(409,"An imported transaction changed account or grouping. Existing records were retained for review.");
    const n=normalizeTransaction(live,id,categories)!;
    batch.push(q("INSERT INTO lunch_money_stage(remote_id,transaction_id,body) SELECT ?1,?3,?4 WHERE "+guard+" ON CONFLICT(remote_id,transaction_id) DO UPDATE SET body=excluded.body",n.id,JSON.stringify(n)));
   }
   batch.push(q("SELECT CASE WHEN NOT "+guard+" OR NOT EXISTS(SELECT 1 FROM lunch_money_stage s JOIN transactions t ON t.plaid_txn_id=?3||s.transaction_id WHERE s.remote_id=?1 AND t.account_id!=?4) THEN 1 ELSE json('account conflict') END",prefix,claim.account_id));
   // Merge by source transaction ID, preserving canonical IDs and all Minty tags/reviews.
   batch.push(q(`INSERT INTO transactions(owner,account_id,plaid_txn_id,amount_cents,currency,date,name,merchant_name,category,pending,account_owner)
    SELECT a.owner,a.id,?3||s.transaction_id,s.body->>'amount_cents',s.body->>'currency',s.body->>'date',s.body->>'name',s.body->>'merchant_name',s.body->>'category',s.body->>'pending',s.body->>'account_owner'
    FROM lunch_money_stage s JOIN lunch_money_accounts l ON l.remote_id=s.remote_id JOIN accounts a ON a.id=l.account_id
    WHERE s.remote_id=?1 AND ${guard}
    ON CONFLICT(plaid_txn_id) DO UPDATE SET amount_cents=excluded.amount_cents,currency=excluded.currency,date=excluded.date,name=excluded.name,merchant_name=excluded.merchant_name,category=excluded.category,pending=excluded.pending,account_owner=excluded.account_owner WHERE transactions.account_id=excluded.account_id`,prefix));
   batch.push(q(`INSERT INTO lunch_money_records(transaction_id,remote_id,source_transaction_id,body,imported_at)
    SELECT t.id,?1,s.transaction_id,s.body->>'body',${NOW} FROM lunch_money_stage s JOIN transactions t ON t.plaid_txn_id=?3||s.transaction_id WHERE s.remote_id=?1 AND ${guard}
    ON CONFLICT(transaction_id) DO UPDATE SET body=excluded.body,imported_at=excluded.imported_at`,prefix));
   batch.push(q("DELETE FROM transactions WHERE plaid_txn_id IN (SELECT value FROM json_each(?3)) AND account_id=(SELECT account_id FROM lunch_money_accounts WHERE remote_id=?1) AND "+guard,JSON.stringify(deleted)));
   batch.push(q(`UPDATE accounts SET balance_current_cents=?3,balance_available_cents=NULL,currency=?4,updated_at=${NOW} WHERE id=(SELECT account_id FROM lunch_money_accounts WHERE remote_id=?1) AND ${guard}`,cents(account.balance),currency(account.currency)));
   batch.push(q(`UPDATE items SET updated_at=${NOW},txn_cursor='lunchmoney',last_error=NULL WHERE id=?3 AND source='lunchmoney' AND ${guard}`,current.item_id));
   batch.push(q("DELETE FROM lunch_money_stage WHERE remote_id=?1 AND "+guard));
   batch.push(q(`INSERT INTO app_state(key,value) SELECT 'audit_dirty','1' WHERE ${guard} ON CONFLICT(key) DO UPDATE SET value='1'`));
   batch.push(q(`UPDATE lunch_money_accounts SET offset=0,cycle_end=NULL,cycle_started=NULL,cycle_since=NULL,cursor=?5,last_full_sync=CASE WHEN ?6 THEN ${NOW} ELSE last_full_sync END,last_success=${NOW},last_error=NULL,source_status=?3,source_updated_at=?4,next_run=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'),lease=NULL,lease_until=NULL WHERE remote_id=?1 AND lease=?2`,str(account.status),account.plaid_last_successful_update||account.last_import||null,new Date(Date.parse(started)-5*60000).toISOString(),since?0:1));
  }
  await env.DB.batch(batch);
  return {remote_id:id,complete:!response.has_more,page_rows:normalized.length};
 } catch(e) {
  const message=e instanceof HttpError?e.detail:"Lunch Money import failed. Existing records were retained.";
  await q(`UPDATE lunch_money_accounts SET last_error=?3,offset=0,cycle_end=NULL,cycle_started=NULL,cycle_since=NULL,next_run=strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes'),lease=NULL,lease_until=NULL WHERE remote_id=?1 AND lease=?2`,message).run();
  return {remote_id:id,error:message};
 }
}
