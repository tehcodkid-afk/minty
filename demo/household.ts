import type { Env } from "../src/env";
import { fingerprint, isSpending, type Transaction } from "../src/household";
/** Preview only: fictional people and classifications. Never imported by production. */
export async function seedHouseholdPreview(env: Env) {
 await env.DB.prepare("INSERT INTO household_settings(id,a_owner,b_owner,a_label,b_label,a_weight,b_weight) VALUES(1,'alex','sam','Alex','Sam',2,1)").run();
 await env.DB.prepare("UPDATE accounts SET purpose='personal' WHERE type!='investment'").run();
 await env.DB.prepare("INSERT INTO household_accounts(account_id) SELECT id FROM accounts WHERE type!='investment'").run();
 const now=new Date(); const month=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
 const rows=(await env.DB.prepare("SELECT * FROM transactions WHERE date>=? AND owner IN ('alex','sam') AND pending=0 AND amount_cents>0 ORDER BY date DESC LIMIT 100").bind(month+'-01').all<Transaction>()).results;
 for (const [i,t] of rows.filter(isSpending).slice(0,8).entries()) {
  const classification=i<4?'household':'personal';
  await env.DB.prepare("INSERT INTO household_reviews(transaction_id,fingerprint,classification,shared_cents,payer,a_weight,b_weight,note,reviewed_by) VALUES(?,?,?,?,?,2,1,'Demo decision — fictional data','demo')")
   .bind(t.id,fingerprint(t),classification,classification==='household'?t.amount_cents:null,t.owner==='alex'?'a':'b').run();
  if(classification==='household')await env.DB.prepare("INSERT INTO transaction_tags(transaction_id,tag,position) VALUES(?,'Household',99) ON CONFLICT DO NOTHING").bind(t.id).run();
 }
}
