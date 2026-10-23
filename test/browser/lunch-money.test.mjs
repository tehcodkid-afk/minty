import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {chromium} from "playwright-core";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {resolve,sep} from "node:path";
let browser,server,base;
before(async()=>{
 const root=fileURLToPath(new URL("../../public/",import.meta.url));
 server=createServer(async(req,res)=>{
  try{
   const path=resolve(root,"."+new URL(req.url,"http://localhost").pathname);
   if(!path.startsWith(root.endsWith(sep)?root:root+sep)){res.writeHead(404);res.end();return;}
   const body=await readFile(path);res.setHeader("Content-Type",path.endsWith(".js")?"application/javascript":path.endsWith(".css")?"text/css":"text/html");res.end(body);
  }catch{res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));base="http://127.0.0.1:"+server.address().port;
 browser=await chromium.launch({headless:true,...(process.platform==="win32"?{channel:"msedge"}:{})});
});
after(async()=>{await browser?.close();server?.closeAllConnections();await new Promise(resolve=>server?server.close(resolve):resolve());});
for(const width of [1280,390])test("select, assign and review accounts at width "+width,async t=>{
 const page=await browser.newPage({viewport:{width,height:844}});t.after(()=>page.close());const errors=[];page.on("pageerror",e=>errors.push(e.message));
 const requests=[];let applied=false;
 const catalog={configured:true,budget_name:"Test household",people:[{key:"me",label:"Me"},{key:"p2",label:"P2"}],selected:[],existing:[{id:10,owner:"me",name:"Original card",mask:"1111",feed:"plaid"}],accounts:[{id:701,name:'Card <img src=x onerror="window.bad=true">',mask:"1111",bank:"Example",status:"active"},{id:702,name:"P2 card",mask:"2222",bank:"Example",status:"active"},{id:703,name:"Business - do not import",mask:"3333",bank:"Example",status:"active"}]};
 await page.route("**/imports/lunchmoney**",async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;let result=catalog;
  if(request.method()==="POST"){
   const body=request.postDataJSON();requests.push({path,body});
   if(path.endsWith("/preview"))result={plan_id:"synthetic-preview",accounts:body.selections.map(s=>({...s,name:s.remote_id===701?"Original card":"P2 card",mask:s.remote_id===701?"1111":"2222",start_date:s.target_id?"2026-10-02":s.start_date})),notice:"Existing posted history stays. New history starts on the reviewed date."};
   if(path.endsWith("/apply")){applied=true;result={ok:true};}
  }
  await route.fulfill({json:result});
 });
 await page.goto(base+"/lunchmoney.html");await page.getByText("Connected to Test household.",{exact:false}).waitFor();
 assert.equal(await page.locator('[name="selected"]:checked').count(),0);
 assert.equal(await page.locator("#accounts img").count(),0);
 const first=page.locator('[data-account="701"]'),second=page.locator('[data-account="702"]');
 await first.locator('[name="selected"]').check();await first.locator('[name="target"]').selectOption("10");
 assert.equal(await first.locator('[name="owner"]').inputValue(),"me");
 await second.locator('[name="selected"]').check();await second.locator('[name="owner"]').selectOption("p2");
 await second.locator('[name="target"]').selectOption("10");assert.equal(await second.locator('[name="owner"]').inputValue(),"p2");await second.locator('[name="target"]').selectOption("");
 await page.locator("#start").fill("2026-01-01");await page.locator("#preview").click();await page.locator("#review").waitFor();
 assert.equal(applied,false);assert.deepEqual(requests[0].body.selections.map(s=>[s.remote_id,s.owner,s.target_id]),[[701,"me",10],[702,"p2",null]]);
 assert.match(await page.locator("#reviewRows").innerText(),/2026-10-02/);assert.doesNotMatch(await page.locator("#reviewRows").innerText(),/Business/);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.locator("#apply").click();await page.getByText("Selection saved.",{exact:false}).waitFor();
 assert.equal(applied,true);assert.deepEqual(requests[1].body,{plan_id:"synthetic-preview",confirm:true});
 assert.deepEqual(errors,[]);
});
test("API failures stay visible and do not apply an import",async t=>{
 const page=await browser.newPage();t.after(()=>page.close());
 await page.route("**/imports/lunchmoney",route=>route.fulfill({status:502,json:{detail:"Lunch Money could not be reached. Existing records were retained."}}));
 await page.goto(base+"/lunchmoney.html");await page.locator("#message.error").waitFor();
 assert.match(await page.locator("#message").innerText(),/Existing records were retained/);
 assert.equal(await page.locator("#review").isVisible(),false);
});
