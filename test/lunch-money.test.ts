import {beforeEach,afterEach,expect,it,vi} from "vitest";
import {env} from "cloudflare:workers";
import {call,loadFixture} from "./helpers";
import {accountType,cents,normalizeTransaction,syncNext} from "../src/lunch-money";
import type {Env} from "../src/env";
import {refreshTotals,markAuditDirty} from "../src/audit/totals";
import {countingDb} from "../src/limits";
const e={...env,LUNCH_MONEY_TOKEN:"synthetic-token"} as unknown as Env;
const accounts=[{id:701,name:"Everyday",mask:"4444",type:"credit",balance:"123.45",currency:"usd",institution_name:"Example",status:"active"},{id:702,name:"Other",mask:"5555",type:"depository",balance:"500",currency:"usd",institution_name:"Example",status:"active"}];
let pages:any[],budget=42;
let single:any;
const row=(id=1,x={})=>({id,plaid_account_id:701,date:"2026-10-01",amount:"12.34",currency:"usd",payee:"Merchant",category_id:1,is_pending:false,is_group_parent:false,split_parent_id:null,...x});
const req=(p:string,b?:unknown,x={})=>call("/imports/lunchmoney"+p,{...(b===undefined?{}:{method:"POST",body:JSON.stringify(b),headers:{"Content-Type":"application/json"}}),envOverrides:{LUNCH_MONEY_TOKEN:"synthetic-token"},...x});
async function select(target_id:number|null=null){
 const r=await req("/preview",{selections:[{remote_id:701,owner:"me",target_id,start_date:"2026-01-01"}]});expect(r.status).toBe(200);
 const p=await r.json() as any;const a=await req("/apply",{plan_id:p.plan_id,confirm:true});expect(await a.clone().text()).not.toContain("changed");expect(a.status).toBe(200);return p;
}
beforeEach(async()=>{
 await env.DB.batch(["DELETE FROM lunch_money_plans","DELETE FROM lunch_money_budget","DELETE FROM lunch_money_stage","DELETE FROM lunch_money_accounts"].map(s=>env.DB.prepare(s)));
 await loadFixture();pages=[];budget=42;single=row();
 vi.stubGlobal("fetch",vi.fn(async(input:any,init:any)=>{
  // Preserve Workers request validation even while substituting the upstream response.
  new Request(input,init);
  const u=new URL(typeof input==="string"?input:input.url);
  expect(u.origin).toBe("https://api.lunchmoney.dev");expect(init.headers.Authorization).toBe("Bearer synthetic-token");expect(init.method??"GET").toBe("GET");
  let d:any;
  if(u.pathname==="/v2/me")d={account_id:budget,budget_name:"Shared"};
  else if(u.pathname==="/v2/plaid_accounts")d={plaid_accounts:accounts};
  else if(u.pathname==="/v2/categories")d={categories:[{id:1,name:"Food",is_income:false,exclude_from_totals:false}]};
  else if(u.pathname==="/v2/transactions"){expect(u.searchParams.get("plaid_account_id")).toBe("701");d=pages.shift()??{transactions:[row()],has_more:false};}
  else if(u.pathname.startsWith("/v2/transactions/")){if(single===null)return new Response("{}",{status:404});d=single;}
  else throw Error("Unexpected endpoint");
  return new Response(JSON.stringify(d),{headers:{"Content-Type":"application/json"}});
 }));
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it("catalog reads metadata without importing accounts or exposing the token",async()=>{
 const r=await req("");expect(r.status).toBe(200);const b=await r.json() as any;expect(b.accounts).toHaveLength(2);expect(JSON.stringify(b)).not.toContain("synthetic-token");
 expect((await env.DB.prepare("SELECT count(*) n FROM accounts").first<any>()).n).toBe(3);
});
it("requires Access, same-origin writes and an explicit preview",async()=>{
 expect((await req("",undefined,{token:null})).status).toBe(403);
 expect((await req("/preview",{},{headers:{Origin:"https://evil.example"}})).status).toBe(403);
 expect((await req("/apply",{confirm:true})).status).toBe(422);
});
it("imports the chosen account idempotently and keeps Minty tags on modified transactions",async()=>{
 await select();expect(await syncNext(e)).toMatchObject({complete:true});
 const t=await env.DB.prepare("SELECT * FROM transactions WHERE plaid_txn_id='lunchmoney:42:1'").first<any>();expect(t.amount_cents).toBe(1234);expect(t.owner).toBe("me");
 expect((await env.DB.prepare("SELECT count(*) n FROM lunch_money_accounts").first<any>()).n).toBe(1);
 await env.DB.prepare("INSERT INTO transaction_tags(transaction_id,tag,position) VALUES(?,'Gold',0)").bind(t.id).run();
 await env.DB.prepare("UPDATE lunch_money_accounts SET next_run=''").run();pages=[{transactions:[row(1,{amount:"20"})],has_more:false}];await syncNext(e);
 expect(await env.DB.prepare("SELECT id,amount_cents FROM transactions WHERE plaid_txn_id='lunchmoney:42:1'").first()).toEqual({id:t.id,amount_cents:2000});
 expect(await env.DB.prepare("SELECT tag FROM transaction_tags WHERE transaction_id=?").bind(t.id).first()).toEqual({tag:"Gold"});
});
it("does not publish incomplete or failed pages",async()=>{
 await select();pages=[{transactions:[row()],has_more:true},{transactions:[],has_more:true}];
 expect((await syncNext(e)).complete).toBe(false);expect(await env.DB.prepare("SELECT id FROM transactions WHERE plaid_txn_id LIKE 'lunchmoney:%'").first()).toBeNull();
 expect((await syncNext(e)).error).toMatch(/pagination/);expect(await env.DB.prepare("SELECT id FROM transactions WHERE plaid_txn_id LIKE 'lunchmoney:%'").first()).toBeNull();
});
it("retains posted Plaid history and starts the replacement after the reviewed cutoff",async()=>{
 const p=await select(10);expect(p.accounts[0].start_date).toBe("2026-09-21");expect(p.accounts[0].pending).toBe(1);
 expect(await env.DB.prepare("SELECT id FROM transactions WHERE id=100").first()).not.toBeNull();expect(await env.DB.prepare("SELECT id FROM transactions WHERE id=101").first()).toBeNull();
 expect(await env.DB.prepare("SELECT feed FROM accounts WHERE id=10").first()).toEqual({feed:"lunchmoney"});
 expect((await syncNext(e)).complete).toBe(true);expect(await env.DB.prepare("SELECT account_id FROM transactions WHERE plaid_txn_id='lunchmoney:42:1'").first()).toEqual({account_id:10});
});
it("rejects another budget and pauses without losing imported records",async()=>{
 await select();await syncNext(e);await env.DB.prepare("UPDATE lunch_money_accounts SET next_run=''").run();budget=99;
 expect((await syncNext(e)).error).toMatch(/different Lunch Money budget/);
 expect(await env.DB.prepare("SELECT id FROM transactions WHERE plaid_txn_id='lunchmoney:42:1'").first()).not.toBeNull();
 expect((await req("/pause",{remote_id:701,enabled:false})).status).toBe(200);expect(await syncNext(e)).toEqual({idle:true});
});
it("avoids double counting split children and group parents and keeps refund signs",()=>{
 const cats=new Map([[1,{name:"Food"}]]);
 expect(normalizeTransaction(row(1,{is_group_parent:true}),701,cats)).toBeNull();
 expect(normalizeTransaction(row(2,{split_parent_id:1}),701,cats)).toBeNull();
 expect(normalizeTransaction(row(3,{is_split_parent:true}),701,cats)?.amount_cents).toBe(1234);
 expect(normalizeTransaction(row(4,{amount:"-12.34"}),701,cats)?.amount_cents).toBe(-1234);
});
it("rejects a stale cutover atomically",async()=>{
 const r=await req("/preview",{selections:[{remote_id:701,owner:"me",target_id:10,start_date:"2026-01-01"}]});const p=await r.json() as any;
 await env.DB.prepare("UPDATE transactions SET date='2026-10-02' WHERE id=100").run();
 expect((await req("/apply",{plan_id:p.plan_id,confirm:true})).status).toBe(409);
 expect(await env.DB.prepare("SELECT feed FROM accounts WHERE id=10").first()).toEqual({feed:"plaid"});
});

it("keeps a transaction omitted by shifting offset pages unless its deletion is confirmed",async()=>{
 await select();await syncNext(e);
 await env.DB.prepare("UPDATE lunch_money_accounts SET next_run=''").run();
 await env.DB.prepare("UPDATE lunch_money_accounts SET last_full_sync=NULL").run();
 pages=[{transactions:[],has_more:false}];single=row();
 expect((await syncNext(e)).complete).toBe(true);
 expect(await env.DB.prepare("SELECT id FROM transactions WHERE plaid_txn_id='lunchmoney:42:1'").first()).not.toBeNull();
 await env.DB.prepare("UPDATE lunch_money_accounts SET next_run=''").run();
 await env.DB.prepare("UPDATE lunch_money_accounts SET last_full_sync=NULL").run();
 pages=[{transactions:[],has_more:false}];single=null;
 expect((await syncNext(e)).complete).toBe(true);
 expect(await env.DB.prepare("SELECT id FROM transactions WHERE plaid_txn_id='lunchmoney:42:1'").first()).toBeNull();
});
it("publishes all pages together and rejects records for an unselected account",async()=>{
 await select();pages=[{transactions:[row(1)],has_more:true},{transactions:[row(2)],has_more:false}];
 expect((await syncNext(e)).complete).toBe(false);expect((await syncNext(e)).complete).toBe(true);
 expect((await env.DB.prepare("SELECT count(*) n FROM transactions WHERE plaid_txn_id LIKE 'lunchmoney:%'").first<any>()).n).toBe(2);
 await env.DB.prepare("UPDATE lunch_money_accounts SET next_run=''").run();pages=[{transactions:[row(3,{plaid_account_id:702})],has_more:false}];
 expect((await syncNext(e)).error).toMatch(/different account/);
 expect((await env.DB.prepare("SELECT count(*) n FROM transactions WHERE plaid_txn_id LIKE 'lunchmoney:%'").first<any>()).n).toBe(2);
});
it("does not apply a preview belonging to another signed-in user",async()=>{
 const p=await (await req("/preview",{selections:[{remote_id:701,owner:"me",start_date:"2026-01-01"}]})).json() as any;
 const {accessToken}=await import("./helpers");
 expect((await req("/apply",{plan_id:p.plan_id,confirm:true},{token:await accessToken({email:"spouse@example.com"}),envOverrides:{LUNCH_MONEY_TOKEN:"synthetic-token",ALLOWED_LOGINS:"me@example.com,spouse@example.com"}})).status).toBe(409);
 expect(await env.DB.prepare("SELECT * FROM lunch_money_accounts").first()).toBeNull();
});
it("rejects source transaction IDs already belonging to a different Minty account",async()=>{
 await select();await env.DB.prepare("UPDATE transactions SET plaid_txn_id='lunchmoney:42:1' WHERE id=100").run();
 expect((await syncNext(e)).error).toMatch(/moved between accounts/);
 expect(await env.DB.prepare("SELECT amount_cents FROM transactions WHERE id=100").first()).toEqual({amount_cents:8412});
});
it("does not publish a page after the account is paused while its API request is in flight",async()=>{
 await select();const original=globalThis.fetch;
 vi.stubGlobal("fetch",vi.fn(async(input:any,init:any)=>{
  if(String(input).includes("/transactions?"))await req("/pause",{remote_id:701,enabled:false});
  return original(input,init);
 }));
 await syncNext(e);
 expect(await env.DB.prepare("SELECT * FROM transactions WHERE plaid_txn_id LIKE 'lunchmoney:%'").first()).toBeNull();
});
it("retains the mapped ledger and balance when its old Plaid connection syncs",async()=>{
 await select(10);await syncNext(e);
 const {FakePlaid,account,page,txn}=await import("./fake-plaid");
 const {fernetEncrypt}=await import("../src/fernet");const {loadConfig}=await import("../src/config");const {syncItem}=await import("../src/sync");
 await env.DB.prepare("UPDATE items SET access_token_enc=? WHERE id=1").bind(await fernetEncrypt("synthetic-access",e.TOKEN_ENC_KEY!)).run();
 const item=await env.DB.prepare("SELECT * FROM items WHERE id=1").first<any>();
 const plaid=new FakePlaid().install();
 plaid.syncPages.push(page("new-cursor",false,{accounts:[account("acct-10"),account("acct-11")],added:[txn("duplicate","acct-10"),txn("new-other","acct-11")],modified:[txn("txn-100","acct-10",{amount:999})],removed:["txn-100"]}));
 expect(await syncItem(e,loadConfig(e),item,{pages:2})).toBe("good");
 expect(await env.DB.prepare("SELECT balance_current_cents FROM accounts WHERE id=10").first()).toEqual({balance_current_cents:12345});
 expect(await env.DB.prepare("SELECT amount_cents FROM transactions WHERE id=100").first()).toEqual({amount_cents:8412});
 expect(await env.DB.prepare("SELECT id FROM transactions WHERE plaid_txn_id='duplicate'").first()).toBeNull();
 expect(await env.DB.prepare("SELECT id FROM transactions WHERE plaid_txn_id='new-other'").first()).not.toBeNull();
});
it("converts decimal amounts exactly and rejects malformed currency",()=>{
 expect(cents("10.075")).toBe(1008);expect(cents("-10.075")).toBe(-1008);expect(cents("0")).toBe(0);
 expect(()=>normalizeTransaction(row(1,{currency:"usdd"}),701,new Map())).toThrow(/currency/);
});


it("lets a reviewed replacement correct the player while preserving transaction IDs and tags",async()=>{
 const p=await (await req("/preview",{selections:[{remote_id:701,owner:"spouse",target_id:10,start_date:"2026-01-01"}]})).json() as any;
 expect(p.accounts[0].previous_owner).toBe("me");
 expect((await req("/apply",{plan_id:p.plan_id,confirm:true})).status).toBe(200);
 expect(await env.DB.prepare("SELECT owner FROM transactions WHERE id=100").first()).toEqual({owner:"spouse"});
 expect(await env.DB.prepare("SELECT tag FROM transaction_tags WHERE transaction_id=100").first()).toEqual({tag:"groceries"});
 expect(await env.DB.prepare("SELECT action FROM household_audit WHERE entity='account' AND entity_id='10' ORDER BY id DESC LIMIT 1").first()).toEqual({action:"change-player"});
});

it("uses an update cursor after history completes and does not delete unchanged rows",async()=>{
 await select();pages=[{transactions:[row(1),row(2)],has_more:false}];await syncNext(e);
 await env.DB.prepare("UPDATE lunch_money_accounts SET next_run=''").run();pages=[{transactions:[row(2,{amount:"25"})],has_more:false}];
 expect((await syncNext(e)).complete).toBe(true);
 expect((await env.DB.prepare("SELECT count(*) n FROM transactions WHERE plaid_txn_id LIKE 'lunchmoney:%'").first<any>()).n).toBe(2);
 const urls=(globalThis.fetch as any).mock.calls.map((c:any)=>String(c[0])).filter((u:string)=>u.includes("/transactions?"));
 expect(new URL(urls[0]).searchParams.has("updated_since")).toBe(false);
 expect(new URL(urls[1]).searchParams.has("updated_since")).toBe(true);
});

it("maps Lunch Money cash and liability accounts to Minty's balance model",()=>{
 expect(accountType("cash")).toBe("depository");expect(accountType("credit")).toBe("credit");
 expect(accountType("other liability")).toBe("loan");expect(accountType("investment")).toBe("investment");
});

it("refuses upstream redirects without forwarding the credential",async()=>{
 const fetcher=vi.fn(async(input:any,init:any)=>{
  const request=new Request(input,init);
  expect(request.redirect).toBe("manual");
  return new Response(null,{status:302,headers:{Location:"https://untrusted.example/collect"}});
 });
 vi.stubGlobal("fetch",fetcher);
 const response=await req("");expect(response.status).toBe(502);
 const body=await response.json() as any;expect(body.detail).toMatch(/HTTP 302/);
 expect(JSON.stringify(body)).not.toMatch(/synthetic-token|untrusted/);
 expect(fetcher).toHaveBeenCalledTimes(1);
 expect(await env.DB.prepare("SELECT * FROM lunch_money_accounts").first()).toBeNull();
});

it("unchanged and empty Lunch Money syncs do not rebuild the full audit",async()=>{
 await select();await syncNext(e);await refreshTotals(e);
 for(const transactions of [[row()],[],[row(1,{notes:"Upstream note changed"})]]){
  await env.DB.prepare("UPDATE lunch_money_accounts SET next_run=''").run();
  pages=[{transactions,has_more:false}];
  expect(await syncNext(e)).toMatchObject({complete:true});
  const measured=countingDb(e.DB);
  expect(await refreshTotals({...e,DB:measured.db})).toEqual({from:null,full:false});
  expect(measured.rows()).toBeLessThanOrEqual(10);
 }
});
it("real Lunch Money corrections and confirmed removals still refresh the audit",async()=>{
 await select();await syncNext(e);await refreshTotals(e);
 await env.DB.prepare("UPDATE lunch_money_accounts SET next_run=''").run();
 pages=[{transactions:[row(1,{amount:"20"})],has_more:false}];
 expect(await syncNext(e)).toMatchObject({complete:true});
 expect(await refreshTotals(e)).toMatchObject({full:true});
 expect(await env.DB.prepare("SELECT amount_cents FROM monthly_totals WHERE month='2026-10' AND category='Food'").first()).toEqual({amount_cents:2000});
 await env.DB.prepare("UPDATE lunch_money_accounts SET next_run='',last_full_sync=NULL").run();
 pages=[{transactions:[],has_more:false}];single=null;
 expect(await syncNext(e)).toMatchObject({complete:true});
 expect(await refreshTotals(e)).toMatchObject({full:true});
 expect(await env.DB.prepare("SELECT amount_cents FROM monthly_totals WHERE month='2026-10' AND category='Food'").first()).toBeNull();
});

it("unchanged full-history reconciliation preserves manual audit invalidation",async()=>{
 await select();await syncNext(e);await refreshTotals(e);
 await env.DB.prepare("UPDATE lunch_money_accounts SET next_run='',last_full_sync=NULL").run();
 expect(await syncNext(e)).toMatchObject({complete:true});
 expect(await refreshTotals(e)).toEqual({from:null,full:false});
 await markAuditDirty(e);
 await env.DB.prepare("UPDATE lunch_money_accounts SET next_run=''").run();
 pages=[{transactions:[],has_more:false}];
 expect(await syncNext(e)).toMatchObject({complete:true});
 expect(await refreshTotals(e)).toMatchObject({full:true});
});
it("nullable ledger changes still invalidate summaries and retain the source record",async()=>{
 await select();await syncNext(e);await refreshTotals(e);
 for(const account_owner of ["Synthetic Owner",null]){
  await env.DB.prepare("UPDATE lunch_money_accounts SET next_run=''").run();
  pages=[{transactions:[row(1,{plaid_metadata:{account_owner}})],has_more:false}];
  expect(await syncNext(e)).toMatchObject({complete:true});
  expect(await refreshTotals(e)).toMatchObject({full:true});
  expect(await env.DB.prepare("SELECT account_owner FROM transactions WHERE plaid_txn_id='lunchmoney:42:1'").first()).toEqual({account_owner});
 }
});
