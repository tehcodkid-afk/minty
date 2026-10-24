import { PRODUCTS } from "./catalog";
import type { Env } from "../env";
import { json, jsonBody, unprocessable } from "../http";
export async function productPreferences(env:Env):Promise<Set<string>> {
 const rows=(await env.DB.prepare('SELECT product_id,benefit_id FROM benefit_product_preferences WHERE enabled=0').all<{product_id:string;benefit_id:string}>()).results;
 return new Set(rows.map(r=>`${r.product_id}|${r.benefit_id}`));
}
export async function saveProductPreference(env:Env,request:Request,email:string):Promise<Response>{
 const b=await jsonBody(request) as Record<string,unknown>;
 if(!b||typeof b!=='object'||typeof b.enabled!=='boolean'||!PRODUCTS.some(p=>p.id===b.product_id&&p.benefits.some(c=>c.id===b.benefit_id)))throw unprocessable('Choose a catalog credit and whether you use it');
 await env.DB.batch([
  env.DB.prepare('INSERT INTO benefit_product_preferences(product_id,benefit_id,enabled) VALUES(?,?,?) ON CONFLICT(product_id,benefit_id) DO UPDATE SET enabled=excluded.enabled').bind(b.product_id,b.benefit_id,b.enabled?1:0),
  env.DB.prepare("INSERT INTO household_audit(entity,entity_id,action,detail,actor) VALUES('product-credit',?,'toggle',?,?)").bind(`${b.product_id}|${b.benefit_id}`,JSON.stringify({enabled:b.enabled}),email)
 ]);
 return json({ok:true});
}
