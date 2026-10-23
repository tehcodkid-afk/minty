import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { call, getJson, loadFixture } from "./helpers";
import { splitCents, fingerprint } from "../src/household";
const db=env.DB;
const request=(path:string,method:string,b:unknown) => getJson(path,{method,body:JSON.stringify(b)});
const list=() => getJson("/household?month=2026-09&currency=USD");
const settings={a_owner:"me",b_owner:"spouse",a_label:"Alex",b_label:"Robin",a_weight:2,b_weight:1,revision:0};
async function review(id=100,extra:Record<string,unknown>={}) {
 const data=(await list()).body; const row=data.rows.find((r:any)=>r.id===id);
 return request(`/household/reviews/${id}`,"PUT",{fingerprint:row.fingerprint,revision:row.review?.revision ?? 0,classification:"household",shared_cents:Math.abs(row.amount_cents),payer:row.suggested_payer,a_weight:2,b_weight:1,note:"",...extra});
}
beforeEach(async()=>{
 await loadFixture();
 await db.batch(["household_reviews","household_settings","household_rules","household_settlements","household_audit"].map(t=>db.prepare(`DELETE FROM ${t}`)));
});
describe("household review and settlement",()=>{
 it("suggests groceries without creating debt before confirmation",async()=>{
  const {status,body}=await list();expect(status).toBe(200);expect(body.summary.owed_to_a_cents).toBe(0);
  expect(body.rows.find((r:any)=>r.id===100).suggestion.classification).toBe("household");
  expect((await review()).status).toBe(422);
 });
 it("supports 2:1 shares, partial personal portions and purchases by either person",async()=>{
  expect((await request("/household/settings","PUT",settings)).status).toBe(200);
  expect((await review(100,{shared_cents:6000})).status).toBe(200);
  expect((await list()).body.summary).toMatchObject({household_cents:6000,a_share_cents:4000,b_share_cents:2000,owed_to_a_cents:2000});
  expect((await review(200,{shared_cents:1500})).status).toBe(200);
  expect((await list()).body.summary.owed_to_a_cents).toBe(1000);
 });
 it("rejects pending purchases, oversize portions and unknown payers",async()=>{
  await request("/household/settings","PUT",settings);
  expect((await review(101)).status).toBe(422);
  expect((await review(100,{shared_cents:9000})).status).toBe(422);
  expect((await review(100,{payer:"someone"})).status).toBe(422);
 });
 it("requires rereview when the bank changes a confirmed transaction",async()=>{
  await request("/household/settings","PUT",settings);await review();
  const original=(await list()).body.rows.find((r:any)=>r.id===100);
  await db.prepare("UPDATE transactions SET amount_cents=9000 WHERE id=100").run();
  const changed=(await list()).body;
  expect(changed.summary.owed_to_a_cents).toBe(0);expect(changed.summary.stale).toBe(1);
  expect((await review(100,{fingerprint:original.fingerprint})).status).toBe(409);
 });
 it("rejects competing review edits and logs only successful writes",async()=>{
  await request("/household/settings","PUT",settings);await review();
  expect((await review(100,{revision:0,classification:"personal"})).status).toBe(409);
  expect((await db.prepare("SELECT count(*) AS n FROM household_audit WHERE entity='review'").first<any>()).n).toBe(1);
 });
 it("freezes each confirmed split when the default changes",async()=>{
  await request("/household/settings","PUT",settings);await review();
  const before=(await list()).body.summary;
  expect((await request("/household/settings","PUT",{...settings,a_weight:1,b_weight:1,revision:1})).status).toBe(200);
  expect((await list()).body.summary).toEqual(before);
  expect((await request("/household/settings","PUT",settings)).status).toBe(409);
 });
 it("keeps rules as suggestions and lets transaction-specific decisions win",async()=>{
  await request("/household/settings","PUT",settings);await review(100,{classification:"personal"});
  expect((await request("/household/rules","POST",{transaction_id:100})).status).toBe(200);
  await db.prepare("INSERT INTO transactions(id,owner,account_id,plaid_txn_id,amount_cents,currency,date,name,merchant_name,pending) VALUES(999,'me',10,'new',3000,'USD','2026-09-21','WHOLE FOODS','Whole Foods Market',0)").run();
  const data=(await list()).body;
  expect(data.rows.find((r:any)=>r.id===999).suggestion).toMatchObject({classification:"personal",source:"rule"});
  expect(data.summary.owed_to_a_cents).toBe(0);
  await review(999,{classification:"household"});expect((await list()).body.summary.owed_to_a_cents).toBe(1000);
 });
 it("records idempotent reimbursements and can void them without deleting history",async()=>{
  await request("/household/settings","PUT",settings);await review(100,{shared_cents:6000});
  const payment={id:"reimbursement-test-123",month:"2026-09",date:"2026-10-01",currency:"USD",from_person:"b",amount_cents:1000,note:"Actual payment"};
  expect((await request("/household/settlements","POST",payment)).status).toBe(200);
  expect((await request("/household/settlements","POST",payment)).status).toBe(200);
  expect((await list()).body.summary.owed_to_a_cents).toBe(1000);
  expect((await request("/household/settlements","POST",{...payment,amount_cents:2000})).status).toBe(409);
  expect((await getJson(`/household/settlements/${payment.id}`,{method:"DELETE"})).status).toBe(200);
  expect((await list()).body.summary.owed_to_a_cents).toBe(2000);
  expect((await list()).body.settlements[0].voided_at).toBeTruthy();
 });
 it("separates months and currencies",async()=>{
  await request("/household/settings","PUT",settings);await review();
  await db.prepare("INSERT INTO transactions(id,owner,account_id,plaid_txn_id,amount_cents,currency,date,name,pending) VALUES(999,'me',10,'cad',3000,'CAD','2026-09-21','Store',0)").run();
  expect((await list()).body.rows.some((r:any)=>r.id===999)).toBe(false);
  expect((await getJson("/household?month=2026-10&currency=USD")).body.summary.owed_to_a_cents).toBe(0);
  expect((await getJson("/household?month=2026-13")).status).toBe(422);
 });
 it("lets P2 remain unlinked until their own bank data is added",async()=>{
  expect((await request("/household/settings","PUT",{...settings,b_owner:null})).status).toBe(200);
  expect((await list()).body.rows.find((r:any)=>r.id===200).suggested_payer).toBeNull();
  expect((await review(200)).status).toBe(422);
  expect((await review(200,{payer:"b"})).status).toBe(200);
 });
 it("rejects unauthenticated data access and cross-origin writes",async()=>{
  expect((await call("/household?month=2026-09",{token:null})).status).toBe(403);
  expect((await call("/household/settings",{method:"PUT",headers:{Origin:"https://attacker.example"},body:JSON.stringify(settings)})).status).toBe(403);
 });
 it("rounds refunds symmetrically and reconciles every cent",async()=>{
  for(let cents=1;cents<1000;cents++) {
   const [a,b]=splitCents(cents,2,1),[ra,rb]=splitCents(-cents,2,1);
   expect(a+b).toBe(cents);expect(ra+rb).toBe(-cents);expect(ra+a).toBe(0);expect(rb+b).toBe(0);
  }
  await request("/household/settings","PUT",settings);await review(100,{shared_cents:6000});
  await db.prepare("INSERT INTO transactions(id,owner,account_id,plaid_txn_id,amount_cents,currency,date,name,pending) VALUES(999,'me',10,'refund',-6000,'USD','2026-09-21','Refund',0)").run();
  await review(999);expect((await list()).body.summary.owed_to_a_cents).toBe(0);
 });
});
