"use client";
import { useEffect, useState } from "react";
import { CopyValue } from "./copy-value";
import { UiText } from "./preferences";
import { publicStatusForPlan } from "../lib/transactions/public-status";
import { saveReceipt, type LocalReceipt } from "../lib/transactions/history";
export function LocalTransactionHistory({wallet}:{wallet:string}) {
  const [rows,setRows]=useState<LocalReceipt[]>([]),[busy,setBusy]=useState(""),[notice,setNotice]=useState("");
  useEffect(()=>{
    let live=true;
    const read=()=>{try{const r=JSON.parse(localStorage.getItem("retium-pay:local-history:v1:"+wallet)||"[]");if(live)setRows(Array.isArray(r)?r.filter(x=>x.wallet===wallet&&/^tx_[a-f0-9]{32}$/.test(x.txId)&&x.plan?.wallet===wallet).slice(0,100):[]);}catch{if(live)setRows([]);}};
    Promise.resolve().then(read);window.addEventListener("retium-local-history",read);window.addEventListener("storage",read);
    return()=>{live=false;window.removeEventListener("retium-local-history",read);window.removeEventListener("storage",read);};
  },[wallet]);
  async function check(row:LocalReceipt){
    if(busy)return;setBusy(row.txId);setNotice("");
    try{const result=await publicStatusForPlan(row.plan,row.txId,wallet);saveReceipt({...result});}
    catch{setNotice("Status check unavailable. No transaction was resent.");}
    finally{setBusy("");}
  }
  const visible=rows.filter(r=>r.wallet===wallet);
  if(!wallet||!visible.length)return null;
  return <section className="preview" aria-label="On-chain activity saved on this device"><h2><UiText text="On-chain activity on this device" /></h2><p className="muted"><UiText text="DEX, Deploy and Lending results. Refresh checks the public chain; it never signs or sends a transaction." /></p>
    {visible.map(row=><div key={row.txId} className="history-row"><p><strong>{row.plan.approval?"Approve":row.plan.deployment?"Deploy":row.plan.call.method}</strong> · <UiText text={row.state==="confirmed"?"HardFinal · execution OK":row.state} /></p><CopyValue value={row.txId}/><button disabled={!!busy} onClick={()=>void check(row)}><UiText text={busy===row.txId?"Checking…":"Refresh status"}/></button></div>)}
    <p role="status">{notice}</p><p className="muted"><UiText text="Payment and Split Bill records below use your private viewing session." /></p></section>;
}
