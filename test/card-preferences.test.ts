import {beforeEach,it,expect} from 'vitest';
import {env} from 'cloudflare:workers';
import {getJson,loadFixture} from './helpers';
const db=env.DB;
const put=(path:string,body:unknown)=>getJson<any>(path,{method:'PUT',body:JSON.stringify(body)});
beforeEach(async()=>{await loadFixture();await db.prepare('DELETE FROM benefit_product_preferences').run();await db.prepare('DELETE FROM household_accounts').run();});
it('requires assignment, filters cards, and isolates churning from personal and household spend without deleting tags',async()=>{
 const list=()=>getJson<any>('/household?month=2026-09');
 expect((await list()).body.personal.every((p:any)=>p.amount_cents===0)).toBe(true);
 expect((await put('/household/accounts/10',{purpose:'personal'})).status).toBe(200);
 expect((await list()).body.personal[0].amount_cents).toBe(8412);
 expect((await getJson<any[]>('/transactions?purpose=personal')).body.every(t=>t.account_id===10)).toBe(true);
 await put('/transactions/100/tags',{tags:['Household']});
 expect((await list()).body.rows).toHaveLength(1);
 await put('/household/accounts/10',{purpose:'churning'});
 expect((await list()).body.rows).toHaveLength(0);
 expect((await list()).body.personal[0].amount_cents).toBe(0);
 expect((await getJson<any[]>('/transactions?purpose=churning')).body.find(t=>t.id===100).tags).toEqual(['Household']);
 expect((await put('/household/accounts/10',{purpose:'unknown'})).status).toBe(422);
 expect((await getJson('/transactions?purpose=unknown')).status).toBe(422);
});
it('toggles a product credit across players, restores usage, and preserves dependent credit calculations',async()=>{
 await db.prepare("UPDATE items SET institution_name='American Express'").run();
 await db.prepare("UPDATE accounts SET name='Business Platinum Card',type='credit' WHERE id IN (10,20)").run();
 await db.prepare("INSERT INTO transactions(owner,account_id,plaid_txn_id,date,amount_cents,name) VALUES('me',10,'dell-test','2026-09-01',-20000,'Dell Statement Credit Benefit')").run();
 const list=()=>getJson<any>('/benefits?year=2026');
 const before=(await list()).body;
 expect(before.cards.filter((c:any)=>[10,20].includes(c.account_id)).every((c:any)=>c.benefits.some((b:any)=>b.id==='dell'))).toBe(true);
 expect((await put('/benefits/preferences',{product_id:'amex_business_platinum',benefit_id:'dell',enabled:false})).status).toBe(200);
 const after=(await list()).body;
 for(const id of [10,20])expect(after.cards.find((c:any)=>c.account_id===id).benefits.some((b:any)=>b.id==='dell')).toBe(false);
 const plus=(v:any)=>v.cards.find((c:any)=>c.account_id===10).benefits.find((b:any)=>b.id==='dell_plus');
 expect(plus(after)).toEqual(plus(before));
 expect(after.ending_soon.some((b:any)=>b.benefit_id==='dell')).toBe(false);
 await put('/benefits/preferences',{product_id:'amex_business_platinum',benefit_id:'dell',enabled:true});
 expect((await list()).body.totals).toEqual(before.totals);
 expect((await put('/benefits/preferences',{product_id:'nope',benefit_id:'dell',enabled:false})).status).toBe(422);
});

it('manual portal credits use the chosen account anniversary',async()=>{
 await db.prepare("UPDATE items SET institution_name='Capital One' WHERE id=1").run();
 await db.prepare("UPDATE accounts SET name='Venture X' WHERE id=10").run();
 await put('/benefits/cards/10',{product_id:'venture_x',anniversary_month:9});
 expect((await put('/benefits/marks',{account_id:10,benefit_id:'travel',period_start:'2026-09-01',used:true})).status).toBe(200);
 const data=(await getJson<any>('/benefits?year=2026')).body;
 expect(data.cards.find((c:any)=>c.account_id===10).benefits.find((b:any)=>b.id==='travel').used_this_year_cents).toBe(30000);
 expect((await put('/benefits/marks',{account_id:10,benefit_id:'travel',period_start:'2026-01-01',used:true})).status).toBe(422);
});
