(() => {
const $=id=>document.getElementById(id);
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let data,plan,busy=false;
$("start").value=new Date().getFullYear()+"-01-01";
async function api(path="",body) {
 const r=await fetch("/imports/lunchmoney"+path,body===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
 const result=await r.json();if(!r.ok)throw Error(result.detail||"Import request failed.");return result;
}
function message(text,error=false){$("message").textContent=text;$("message").className=error?"error":"";}
async function action(fn){if(busy)return;busy=true;document.querySelectorAll("button").forEach(b=>b.disabled=true);try{await fn();}catch(e){message(e.message,true);}finally{busy=false;document.querySelectorAll("button").forEach(b=>b.disabled=false);}}
function player(key){return data.people.find(p=>p.key===key)?.label||key;}
async function refresh(){
 data=await api();$("setup").hidden=data.configured;$("selection").hidden=!data.configured;$("sync").hidden=!data.configured;
 $("progress").innerHTML=data.selected.length?"<h2>Imported accounts</h2>"+data.selected.map(a=>`<div class="progress"><strong>${esc(a.name)}${a.mask?" / "+esc(a.mask):""}</strong> / ${esc(player(a.owner))}<br><small>${!a.enabled?"Paused":a.last_error?esc(a.last_error):a.offset?"Importing history: "+a.offset+" source rows fetched":a.last_success?"Last imported "+esc(new Date(a.last_success).toLocaleString()):"Waiting for first import"} / Since ${esc(a.start_date)}${a.source_status?" / Lunch Money: "+esc(a.source_status):""}</small> <button type="button" data-pause="${a.remote_id}" data-enabled="${a.enabled?0:1}">${a.enabled?"Pause":"Resume"}</button></div>`).join(""):"";
 const imported=new Set(data.selected.map(a=>a.remote_id));
 $("accounts").innerHTML=data.accounts.filter(a=>!imported.has(a.id)).map(a=>`<div class="account" data-account="${a.id}" data-search="${esc((a.name+" "+a.bank+" "+(a.mask||"")).toLowerCase())}"><label class="title"><input type="checkbox" name="selected"><span><strong>${esc(a.name)}</strong><small>${esc(a.bank)} / ${esc(a.mask||"No ending digits")} / ${esc(a.status)}</small></span></label><label>Player<select name="owner"><option value="">Choose player</option>${data.people.map(p=>`<option value="${esc(p.key)}">${esc(p.label)}</option>`).join("")}</select></label><div><label>Minty account<select name="target"><option value="">New account</option>${data.existing.filter(e=>e.feed==="plaid").map(e=>`<option value="${e.id}" data-owner="${esc(e.owner)}">${esc(e.name)} / ${esc(e.mask||"")} / ${esc(player(e.owner))}</option>`).join("")}</select></label><label><input type="checkbox" name="distinct"> If ending digits match, this is a separate account.</label></div></div>`).join("")||"<p>All available accounts have been imported.</p>";
 if(data.configured)message("Connected to "+data.budget_name+". Select only the accounts you want to import.");
}
$("refresh").onclick=()=>action(refresh);
$("search").oninput=()=>document.querySelectorAll("[data-account]").forEach(el=>el.hidden=!el.dataset.search.includes($("search").value.toLowerCase()));
$("accounts").onchange=e=>{if(e.target.name==="target"){const row=e.target.closest("[data-account]"),option=e.target.selectedOptions[0];if(option.dataset.owner&&!row.querySelector('[name="owner"]').value)row.querySelector('[name="owner"]').value=option.dataset.owner;}};
$("selection").onsubmit=e=>{e.preventDefault();action(async()=>{
 const selections=[...document.querySelectorAll("[data-account]")].filter(el=>el.querySelector('[name="selected"]').checked).map(el=>({remote_id:Number(el.dataset.account),owner:el.querySelector('[name="owner"]').value,target_id:Number(el.querySelector('[name="target"]').value)||null,start_date:$("start").value,distinct:el.querySelector('[name="distinct"]').checked}));
 plan=await api("/preview",{selections});
 $("reviewRows").innerHTML=plan.accounts.map(a=>`<p><strong>${esc(a.name)} / ${esc(a.mask||"")}</strong> &rarr; ${esc(player(a.owner))}<br>${a.target_id?"Switch existing Minty account #"+a.target_id:"Add a new account"}${a.previous_owner&&a.previous_owner!==a.owner?" / Reassign saved history from "+esc(player(a.previous_owner))+" to "+esc(player(a.owner)):""} / Lunch Money history from <strong>${esc(a.start_date)}</strong>${a.pending?" / Replace "+a.pending+" pending Plaid rows":""}</p>`).join("");
 $("reviewNotice").textContent=plan.notice;$("review").hidden=false;$("selection").hidden=true;$("review").scrollIntoView({block:"start"});message("Review the account assignments and dates before confirming.");
});};
$("cancel").onclick=()=>{$("review").hidden=true;$("selection").hidden=false;plan=null;};
$("apply").onclick=()=>action(async()=>{await api("/apply",{plan_id:plan.plan_id,confirm:true});$("review").hidden=true;plan=null;await refresh();message("Selection saved. Use Import next batch to begin now; background imports continue automatically.");});
$("sync").onclick=()=>action(async()=>{const r=await api("/sync",{});await refresh();message(r.error?r.error:r.idle?"No import is due right now.":r.waiting_for_start?"This account starts importing on its reviewed cutoff date.":r.complete?"Account history imported. Continue for the next account.":"Another page was fetched. Continue to finish the history.",!!r.error);});
$("progress").onclick=e=>{const b=e.target.closest("[data-pause]");if(b)action(async()=>{await api("/pause",{remote_id:Number(b.dataset.pause),enabled:b.dataset.enabled==="1"});await refresh();});};
action(refresh);
})();