import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {chromium} from "playwright-core";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {resolve,sep} from "node:path";
let browser,server,base;
before(async()=>{
 const root=fileURLToPath(new URL("../../dist/demo/",import.meta.url));
 server=createServer(async(req,res)=>{
  try{
   const path=resolve(root,"."+new URL(req.url,"http://localhost").pathname.replace(/\/$/,"/index.html"));
   if(!path.startsWith(root.endsWith(sep)?root:root+sep)){res.writeHead(404);res.end();return;}
   const body=await readFile(path);res.setHeader("Content-Type",path.endsWith(".js")?"application/javascript":path.endsWith(".css")?"text/css":path.endsWith(".svg")?"image/svg+xml":"text/html");res.end(body);
  }catch{res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.platform==="win32"?{channel:"msedge"}:{})});
});
after(async()=>{await browser?.close();server?.closeAllConnections();await new Promise(resolve=>server?server.close(resolve):resolve());});

// This runs the real frontend and Worker API over the demo's in-browser SQLite database.
// All data is fictional. sql.js is fetched from the demo's pinned CDN with integrity checks.
test("keyboard tagging, undo, Household ledger and monthly entries work end to end",async t=>{
 const page=await browser.newPage();t.after(()=>page.close());const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/?tagging');await page.locator('[data-row]').first().waitFor();await page.locator('#hhOwner').selectOption('alex');
 const first=await page.locator('.hh-quick-row.active').getAttribute('data-row');
 await page.locator('.hh-quick-row.active').click();await page.keyboard.press('s');
 await page.locator('#householdMessage').filter({hasText:'Sweeps saved.'}).waitFor();
 assert.notEqual(await page.locator('.hh-quick-row.active').getAttribute('data-row'),first);
 await page.locator('[data-undo]').click();await page.locator('#householdMessage').filter({hasText:'Last tag undone.'}).waitFor();
 assert.equal(await page.locator('.hh-quick-row.active').getAttribute('data-row'),first);
 await page.keyboard.press('h');await page.locator('#householdMessage').filter({hasText:'Household saved.'}).waitFor();
 await page.locator('[data-view="household"]').click();await page.locator('.hh-ledger-row').first().waitFor();
 await page.getByText('Add an expense · rent, pet sitters, etc.',{exact:true}).click();
 await page.locator('#hhEntry input[name="name"]').fill('Demo rent');await page.locator('#hhEntry input[name="amount"]').fill('1500');
 await page.locator('#hhEntry input[name="recurring"]').check();await page.locator('#hhEntry button').click();
 await page.locator('#householdMessage').filter({hasText:'Added for this month'}).waitFor();
 assert.equal(await page.locator('.hh-line strong').filter({hasText:'Demo rent'}).count(),1);
 await page.getByText('Monthly expenses · 1',{exact:true}).click();await page.locator('[data-apply-recurring]').click();
 await page.locator('#householdMessage').filter({hasText:'Recurring expenses added once'}).waitFor();
 assert.equal(await page.locator('.hh-line strong').filter({hasText:'Demo rent'}).count(),1);
 assert.deepEqual(errors,[]);
});

test("typing in a field does not tag, failed saves do not advance, and mobile fits",async t=>{
 const page=await browser.newPage({viewport:{width:390,height:844}});t.after(()=>page.close());
 await page.goto(base+"/?tagging");await page.locator("[data-row]").first().waitFor();
 await page.locator("#hhOwner").selectOption("alex");
 await page.locator("#hhSearch").fill("s");await page.locator("#hhSearch").fill("");
 assert.equal(await page.locator("[data-undo]").isDisabled(),true);
 const first=await page.locator(".hh-quick-row.active").getAttribute("data-row");
 await page.evaluate(()=>{
  const original=window.fetch;window.fetch=(path,options)=>options?.method==="PUT"&&String(path).includes("/household/reviews/")?Promise.resolve(new Response(JSON.stringify({detail:"Test save failed"}),{status:503,headers:{"content-type":"application/json"}})):original(path,options);
 });
 await page.locator(".hh-quick-row.active").click();await page.keyboard.press("D");
 await page.locator("#householdMessage").filter({hasText:"Test save failed"}).waitFor();
 assert.equal(await page.locator(".hh-quick-row.active").getAttribute("data-row"),first);
 assert.equal(await page.locator("[data-undo]").isDisabled(),true);
 assert.equal(await page.locator("#household").evaluate(el=>el.scrollWidth>el.clientWidth),false);
});

test("card purpose saves on mobile and filters the dashboard",async t=>{
 const page=await browser.newPage({viewport:{width:390,height:844}});t.after(()=>page.close());
 await page.goto(base+'/?tagging');await page.locator('[data-view="cards"]').click();
 const select=page.locator('[data-account]').first();await select.waitFor();const id=await select.getAttribute('data-account');
 await select.selectOption('churning');await page.locator('#householdMessage').filter({hasText:'Card purpose saved'}).waitFor();
 assert.equal(await page.locator(`[data-account="${id}"]`).inputValue(),'churning');
 assert.equal(await page.locator('#household').evaluate(el=>el.scrollWidth>el.clientWidth),false);
 await page.locator('#household .abc-close button').click();
 await page.locator('#purposeFilter').selectOption('churning');
 const rows=await page.evaluate(()=>fetch('/transactions?purpose=churning').then(r=>r.json()));
 assert.ok(rows.length>0);assert.ok(rows.every(r=>String(r.account_id)===id));
});
test("product credit switches persist and stay open for quick editing",async t=>{
 const page=await browser.newPage();t.after(()=>page.close());await page.goto(base+'/?abc');
 await page.locator('[data-product-credit]').first().waitFor({state:'attached'});
 await page.getByText('Credits I use', {exact:false}).first().click();
 const checkbox=page.locator('[data-product-credit]').first();
 await checkbox.evaluate(el=>el.closest('details').open=true);
 const product=await checkbox.getAttribute('data-product-credit'),benefit=await checkbox.getAttribute('data-benefit-id');
 await checkbox.uncheck();
 await page.waitForFunction(({product,benefit})=>{const e=document.querySelector(`[data-product-credit="${product}"][data-benefit-id="${benefit}"]`);return e&&!e.checked&&!e.disabled;},{product,benefit});
 assert.equal(await page.locator(`[data-product-credit="${product}"][data-benefit-id="${benefit}"]`).isVisible(),true);
 const data=await page.evaluate(()=>fetch('/benefits').then(r=>r.json()));
 assert.ok(data.cards.filter(c=>c.product?.id===product).every(c=>!c.benefits.some(b=>b.id===benefit)));
});
