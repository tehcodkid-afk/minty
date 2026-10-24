import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { getJson, loadFixture } from "./helpers";
const db=env.DB;
const send=(path:string,method:string,body:unknown)=>getJson(path,{method,body:JSON.stringify(body)});
const list=(view="household",month="2026-09")=>getJson(`/household?month=${month}&currency=USD&view=${view}`);
const split={a_owner:"me",b_owner:"spouse",a_label:"Alex",b_label:"Robin",a_weight:2,b_weight:1,revision:0};
async function select(id=10){return send(`/household/accounts/${id}`,"PUT",{enabled:true});}
async function payload(id:number,tag:string){const row=(await list("tagging")).body.rows.find((r:any)=>r.id===id);const h=tag==="Household";return {fingerprint:row.fingerprint,revision:row.review?.revision||0,classification:h?"household":tag==="Personal"?"personal":"churning",shared_cents:h?Math.abs(row.amount_cents):null,payer:h?row.suggested_payer:null,a_weight:h?2:null,b_weight:h?1:null,expected_tags:row.tags,tags:[...row.tags.filter((t:string)=>!['sweeps','debit','gold','household'].includes(t.toLowerCase())),...(tag==="Personal"?[]:[tag])]};}
async function tag(id:number,t:string){return send(`/household/reviews/${id}`,"PUT",await payload(id,t));}
beforeEach(async()=>{
 await loadFixture();await db.batch(["household_entries","household_recurring","household_accounts","merchant_categories","household_ai_usage","household_reviews","household_settings","household_rules","household_settlements","household_audit"].map(t=>db.prepare(`DELETE FROM ${t}`)));
 await send("/household/settings","PUT",split);
});
describe("tag-first spending workflow",()=>{
 it("shows only Household tags and leaves untagged spending personal by owner",async()=>{
  const data=(await list()).body;expect(data.rows).toEqual([]);expect(data.summary.household_cents).toBe(0);
  expect(data.personal).toEqual([{owner:"me",label:"Me",amount_cents:0},{owner:"spouse",label:"Spouse",amount_cents:0}]);
  expect((await list("candidates")).body.rows).toEqual([]);
  await select();expect((await list("candidates")).body.rows.map((r:any)=>r.id)).toEqual([100]);
  expect((await list()).body.rows).toEqual([]);
  expect((await tag(100,"Household")).status).toBe(200);
  const updated=(await list()).body;expect(updated.rows.map((r:any)=>r.id)).toEqual([100]);
  expect(updated.summary.household_cents).toBe(8412);expect(updated.summary.owed_to_a_cents).toBe(2804);
  expect(updated.personal[0].amount_cents).toBe(0);
 });
 it.each(["Sweeps","Debit","Gold"])("%s tags stay out of both Household and misc totals",async category=>{
  await select();
  expect((await tag(100,category)).status).toBe(200);
  expect((await list()).body.rows).toEqual([]);expect((await list()).body.personal[0].amount_cents).toBe(0);
  const row=(await list("tagging")).body.rows.find((r:any)=>r.id===100);expect(row.tags).toEqual(["groceries",category]);
  await tag(100,"Personal");expect((await list()).body.personal[0].amount_cents).toBe(8412);
 });
 it("requires a selected card for new H tags and supports either payer",async()=>{
  expect((await tag(100,"Household")).status).toBe(422);
  await select(20);expect((await tag(200,"Household")).status).toBe(200);
  expect((await list()).body.summary.owed_to_a_cents).toBe(-1033);
  await send("/household/accounts/20","PUT",{enabled:false});expect((await list()).body.rows).toHaveLength(0);
  expect((await tag(201,"Household")).status).toBe(422);
 });
 it("tag changes and split changes succeed or fail together under concurrent edits",async()=>{
  await select();const original=await payload(100,"Household");await tag(100,"Gold");
  expect((await send("/household/reviews/100","PUT",original)).status).toBe(409);
  expect((await list()).body.rows).toHaveLength(0);
  expect((await list("tagging")).body.rows.find((r:any)=>r.id===100).tags).toEqual(["groceries","Gold"]);
  const next=await payload(100,"Household");next.revision=0;
  expect((await send("/household/reviews/100","PUT",next)).status).toBe(409);
  expect((await db.prepare("SELECT count(*) n FROM household_audit WHERE entity='review'").first<any>()).n).toBe(1);
 });
 it("removing H or adding a conflicting workflow tag excludes the saved split",async()=>{
  await select();await tag(100,"Household");
  await send("/transactions/100/tags","PUT",{tags:["Household","Gold"]});expect((await list()).body.summary.household_cents).toBe(0);
  await send("/transactions/100/tags","PUT",{tags:[]});expect((await list()).body.rows).toHaveLength(0);
  expect((await list()).body.personal[0].amount_cents).toBe(8412);
 });
 it("generic Household tags on personal cards are visible but require a confirmed split",async()=>{
  await select();
  await send("/transactions/100/tags","PUT",{tags:["household"]});
  const d=(await list()).body;expect(d.rows).toHaveLength(1);expect(d.summary.needs_review).toBe(1);expect(d.summary.owed_to_a_cents).toBe(0);
 });
 it("pending purchases cannot be tagged and refunds reduce personal spend",async()=>{
  await select();
  expect((await tag(101,"Gold")).status).toBe(422);
  await db.prepare("UPDATE transactions SET amount_cents=-8412 WHERE id=100").run();
  expect((await list()).body.personal[0].amount_cents).toBe(-8412);
 });
 it("manual entries apply the split, remain month scoped and are idempotent",async()=>{
  const b={id:"manual-rent-123456",month:"2026-09",name:"Rent",currency:"USD",amount_cents:150000,payer:"a"};
  expect((await send("/household/entries","POST",b)).status).toBe(200);expect((await send("/household/entries","POST",b)).status).toBe(200);
  expect((await list()).body.summary).toMatchObject({household_cents:150000,owed_to_a_cents:50000});
  expect((await list("household","2026-10")).body.entries).toHaveLength(0);
  expect((await send("/household/entries","POST",{...b,amount_cents:100})).status).toBe(409);
  await getJson(`/household/entries/${b.id}`,{method:"DELETE"});expect((await list()).body.summary.household_cents).toBe(0);
 });
 it("recurrence adds its first month and only one copy per later month, even after voiding",async()=>{
  const b={id:"recurring-pets-123456",month:"2026-09",name:"Pet sitters",currency:"USD",amount_cents:9000,payer:"b"};
  expect((await send("/household/recurring","POST",b)).status).toBe(200);
  expect((await list()).body.summary.owed_to_a_cents).toBe(-6000);
  await send("/household/recurring/apply","POST",{month:"2026-08",currency:"USD"});expect((await list("household","2026-08")).body.entries).toHaveLength(0);
  for(let i=0;i<2;i++)await send("/household/recurring/apply","POST",{month:"2026-10",currency:"USD"});
  const october=(await list("household","2026-10")).body;expect(october.entries).toHaveLength(1);
  await getJson(`/household/entries/${october.entries[0].id}`,{method:"DELETE"});
  await send("/household/recurring/apply","POST",{month:"2026-10",currency:"USD"});expect((await list("household","2026-10")).body.summary.household_cents).toBe(0);
  await getJson(`/household/recurring/${b.id}`,{method:"DELETE"});await send("/household/recurring/apply","POST",{month:"2026-11",currency:"USD"});
  expect((await list("household","2026-11")).body.entries).toHaveLength(0);expect((await list()).body.summary.owed_to_a_cents).toBe(-6000);
 });
 it("merchant categories never reclassify a transaction or change the split",async()=>{
  await select();
  expect((await send("/household/categories","PUT",{transaction_id:100,category:"Groceries"})).status).toBe(200);
  const d=(await list("tagging")).body;expect(d.rows.find((r:any)=>r.id===100).merchant_category.category).toBe("Groceries");
  expect(d.summary.household_cents).toBe(0);expect(d.personal[0].amount_cents).toBe(8412);
 });
 it("AI receives only merchant/category, suggests without saving, and enforces its daily cap",async()=>{
  const run=vi.fn().mockResolvedValue({response:'{"category":"Groceries"}'});
  const init={method:"POST",body:JSON.stringify({transaction_id:100}),envOverrides:{AI:{run}}};
  const result=await getJson("/household/categories/suggest",init);expect(result.status).toBe(200);expect(result.body.category).toBe("Groceries");
  const prompt=JSON.parse(run.mock.calls[0][1].messages[1].content);expect(prompt).toEqual({merchant:"Whole Foods Market",bank_category:"FOOD_AND_DRINK"});
  expect((await db.prepare("SELECT count(*) n FROM merchant_categories").first<any>()).n).toBe(0);
  await db.prepare("UPDATE household_ai_usage SET requests=50").run();expect((await getJson("/household/categories/suggest",init)).status).toBe(429);expect(run).toHaveBeenCalledTimes(1);
 });
 it("rejects malformed AI output and works without an AI binding",async()=>{
  const base={method:"POST",body:JSON.stringify({transaction_id:100})};
  expect((await getJson("/household/categories/suggest",{...base,envOverrides:{AI:undefined}})).status).toBe(503);
  expect((await getJson("/household/categories/suggest",{...base,envOverrides:{AI:{run:async()=>({response:'{"category":"Household"}'})}}})).status).toBe(502);
 });
});
