import type { Plan } from "../dex/math";
import { verifyDexTx } from "./verify";
export function decodePlan(ticket: string): Plan {
  if(typeof ticket !== "string" || ticket.length > 10000) throw Error("Invalid saved request.");
  const [payload, sig, ...extra] = ticket.split(".");
  if(extra.length || !/^[a-f0-9]{64}$/.test(sig || "")) throw Error("Invalid saved request.");
  const bytes=Uint8Array.from(atob(payload.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
  const p=JSON.parse(new TextDecoder().decode(bytes)) as Plan;
  if(!p || !/^rete[a-f0-9]{68}$/.test(p.wallet)||!Number.isSafeInteger(p.nonce)||!p.call||!/^[a-f0-9]{64}$/.test(p.call.contractId)||!Array.isArray(p.call.args)||p.call.args.some(a=>typeof a!=="string"))throw Error("Invalid saved request.");
  // Decoding does not verify the HMAC. Browser status is not a payment settlement proof.
  return p;
}
export async function publicRead(endpoint:string) {
  const response=await fetch(`https://rpc.retium.org/api/${endpoint}`,{cache:"no-store",redirect:"error",credentials:"omit",signal:AbortSignal.timeout(12000),headers:{Accept:"application/json"}});
  if(!response.ok)throw Error(`Chain status unavailable (HTTP ${response.status}). No transaction was resent.`);
  const text=await response.text();if(text.length>1000000)throw Error("Chain response too large.");
  return JSON.parse(text) as Record<string,unknown>;
}
export async function publicStatus(ticket:string,txId:string,wallet:string) {
  const plan=decodePlan(ticket);
  return publicStatusForPlan(plan,txId,wallet);
}
export async function publicStatusForPlan(plan:Plan,txId:string,wallet:string) {
  if(plan.wallet!==wallet||!/^tx_[a-f0-9]{32}$/.test(txId))throw Error("Saved transaction belongs to another wallet.");
  const tx=await publicRead(`transaction/${txId}`);
  let state: "pending"|"confirmed"|"failed"|"review"=verifyDexTx(tx,{txId,wallet,plan}),error="";
  if(state==="confirmed"){
    const pins=plan.deployment?[[plan.call.contractId,plan.deployment.codeHash]]:plan.lending?[[plan.lending.market,plan.lending.marketCodeHash],[plan.lending.asset,plan.lending.assetCodeHash]]:[];
    for(const [id,hash] of pins){const c=await publicRead(`contract/${id}`);if(c.contract_id!==id||c.code_hash!==hash){state="review";error="Contract code differs from the approved request.";break;}}
  }
  return {txId,wallet,plan,state,error,notice:"disabled",verification:"public_rpc"};
}
