import type { Plan } from "../dex/math";
export type LocalReceipt = {txId:string;wallet:string;plan:Plan;state:string;checkedAt:number};
export function saveReceipt(receipt:Omit<LocalReceipt,"checkedAt"> & {checkedAt?:number}) {
  const key="retium-pay:local-history:v1:"+receipt.wallet;
  const old=JSON.parse(localStorage.getItem(key)||"[]");
  const rows=Array.isArray(old)?old:[];
  localStorage.setItem(key,JSON.stringify([{...receipt,checkedAt:receipt.checkedAt??Date.now()},...rows.filter(r=>r.txId!==receipt.txId)].slice(0,100)));
  window.dispatchEvent(new Event("retium-local-history"));
}
// History sessions protect server records; they do not gate a swap, deployment or loan.
export async function syncHistory(ticket:string,txId:string,wallet:string) {
  try {
    const r=await fetch("/api/payments?action=session",{cache:"no-store",signal:AbortSignal.timeout(5000)});
    if(!r.ok)return false;
    const session=await r.json();if(session.address!==wallet||session.expiresAt<=Date.now())return false;
    const out=await fetch("/api/dex",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({operation:"register",ticket,txId}),signal:AbortSignal.timeout(8000)});
    return out.ok;
  }catch{return false;}
}
