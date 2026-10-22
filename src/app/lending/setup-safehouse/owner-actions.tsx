"use client";
import { useEffect, useRef, useState } from "react";
import { CopyValue } from "../../../components/copy-value";
import { readPublic } from "../../../lib/lending/browser";
import { SETUP_OWNER, SETUP_HASH, SETUP_ASSET, SETUP_ASSET_HASH } from "../../../lib/lending/setup-safehouse";
const ORACLE = "rete5562395fa3d8f4713742d55de025e43ed6e34628ef3657e39033b069808527229e82";
const PROBE = "1000000000000000";
type Action = "approve" | "asset_probe" | "set_oracle" | "activate";
type Operation = { method: Action; contract: string; args: string[]; nonce: number; expires: number; txId: string };
function errorText(e: unknown) { return e && typeof e === "object" && "message" in e ? String(e.message).slice(0,600) : "Request failed. Retry the check; do not resend an unknown transaction."; }
export function SafehouseOwnerActions({market,wallet,chain,onMarketState}:{market:string;wallet:string;chain:number;onMarketState?:(active:boolean)=>void}) {
  const key="retium-pay:safehouse-owner-actions:v2:"+market;
  const [loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState(""),[pending,setPending]=useState<Operation|null>(null),[prepared,setPrepared]=useState<Operation|null>(null),[recovery,setRecovery]=useState(""),[status,setStatus]=useState<Record<string,string>|null>(null);
  const lock=useRef(false), current=useRef({wallet,chain});
  useEffect(()=>{current.current={wallet,chain};},[wallet,chain]);
  useEffect(()=>{let live=true;Promise.resolve().then(()=>{if(!live)return;try{const raw=localStorage.getItem(key);if(raw){const p=JSON.parse(raw);if(!["approve","asset_probe","set_oracle","activate"].includes(p.method)||![market,SETUP_ASSET].includes(p.contract)||!Number.isSafeInteger(p.nonce)||typeof p.txId!=="string"||(p.txId&&!/^tx_[a-f0-9]{32}$/.test(p.txId)))throw Error("Saved action invalid; inspect wallet history before retry.");setPending(p);}setLoaded(true);}catch(e){setNotice(errorText(e));}});return()=>{live=false;};},[key,market]);
  function persist(p:Operation|null){if(p)localStorage.setItem(key,JSON.stringify(p));else localStorage.removeItem(key);setPending(p);}
  async function query(contract:string,method:string,args:string[]=[]){const q=await readPublic(`contract/${contract}/query?method=${method}&args=${args.join(",")}`);if(q.ok!==true||q.contract_id!==contract||q.method!==method||typeof q.output!=="string")throw Error("Query unavailable.");return q.output as string;}
  async function checkedMarket(){
    const [c,a,raw]=await Promise.all([readPublic(`contract/${market}`),readPublic(`contract/${SETUP_ASSET}`),query(market,"market")]);
    const m=JSON.parse(raw);
    if(c.code_hash!==SETUP_HASH||c.deployer!==SETUP_OWNER||a.code_hash!==SETUP_ASSET_HASH||m.owner!==SETUP_OWNER||m.version!=="v0.2.0"||m.oracle_mode!=="safehouse_reference_feed"||m.asset!==SETUP_ASSET||m.asset_hash!==SETUP_ASSET_HASH)throw Error("Market, asset or owner mismatch. Stop setup.");
    setStatus(m);onMarketState?.(m.paused === "0");return m;
  }
  function requireOwner(){if(current.current.wallet!==SETUP_OWNER||current.current.chain!==3)throw Error("Select wallet cb37 on testnet chain 3.");}
  async function prepare(method:Action){
    if(lock.current||pending||!loaded)return;lock.current=true;setBusy(true);setPrepared(null);
    try{
      requireOwner();const m=await checkedMarket();
      if(method==="approve"||method==="asset_probe"){
        if(m.asset_verified==="1")throw Error("Asset probe already verified. No second probe needed.");
        if(m.cash!=="0"||m.supply_shares!=="0"||m.debt_shares!=="0")throw Error("Probe requires an empty market.");
        if(method==="asset_probe"){
          const raw=await query(SETUP_ASSET,"allowance",[SETUP_OWNER,market]);const allowance=raw.replace(/^"|"$/g,"");
          if(!/^\d+$/.test(allowance)||BigInt(allowance)<BigInt(PROBE))throw Error("Approve 0.001 RTD first and wait for HardFinal.");
        }
      }
      if(method==="set_oracle"&&m.oracle===ORACLE)throw Error("Publisher is already assigned. No transaction needed.");
      if(method==="activate"){
        if(m.paused==="0")throw Error("Market already active. No transaction needed.");
        if(m.oracle!==ORACLE||m.asset_verified!=="1"||m.price_fresh!=="true"||m.price!=="1000000000000000000")throw Error("Need verified asset, assigned publisher and fresh 1:1 price before activation.");
      }
      const w=await readPublic(`wallet/${SETUP_OWNER}`),nonce=w.nonce??w.next_nonce;
      if(!Number.isSafeInteger(nonce)||nonce<0)throw Error("Nonce unavailable.");
      requireOwner();
      setPrepared({method,contract:method==="approve"?SETUP_ASSET:market,args:method==="approve"?[market,PROBE]:method==="asset_probe"?[PROBE]:method==="set_oracle"?[ORACLE]:[],nonce,expires:Date.now()+60000,txId:""});
      setNotice("Đã chuẩn bị. Bấm Ký bên dưới; chưa gửi giao dịch.");
    }catch(e){setNotice(errorText(e));}finally{lock.current=false;setBusy(false);}
  }
  async function sign(){
    if(lock.current||!prepared||pending)return;lock.current=true;setBusy(true);let held=false;
    try{
      requireOwner();if(Date.now()>prepared.expires){setPrepared(null);throw Error("Preparation expired. Prepare again.");}
      const provider=window.retium;if(!provider)throw Error("Wallet SDK not ready.");
      const p=prepared;persist(p);held=true;setPrepared(null);
      // Synchronous wallet request within click: no awaits before popup.
      const waiting=provider.request({method:"retium_call",params:{contractId:p.contract,method:p.method,args:p.args,amountAtomic:"0"}});
      const r=await waiting as {txId?:string};if(!/^tx_[a-f0-9]{32}$/.test(r?.txId||""))throw Error("No TX ID returned. Inspect wallet history; do not resend.");
      persist({...p,txId:r.txId!});setNotice("TX đã gửi. Bấm Kiểm tra TX; không gửi lại.");
    }catch(e){if(held&&["4001","4300","4100","4101","4102","4200","-32602"].includes(String((e as {code?:unknown})?.code)))persist(null);setNotice(errorText(e));}finally{lock.current=false;setBusy(false);}
  }
  async function check(){
    if(lock.current||!loaded)return;lock.current=true;setBusy(true);
    try{
      await checkedMarket();
      if(!pending){setNotice("Đã đọc lại trạng thái market.");return;}
      const id=pending.txId||recovery.trim();if(!/^tx_[a-f0-9]{32}$/.test(id))throw Error("Paste TX ID from wallet history.");
      const tx=await readPublic(`transaction/${id}`);
      if(tx.tx_id!==id||tx.sender!==SETUP_OWNER||tx.recipient!==pending.contract||tx.action!=="call"||tx.call?.contract!==pending.contract||tx.call?.method!==pending.method||tx.amount!=="0"||tx.nonce!==pending.nonce)throw Error("Transaction identity differs from this prepared action.");
      if(["Rejected","Voided","Failed"].includes(String(tx.finality||tx.status))||tx.exec_error||tx.rejection_reason||(tx.exec_status&&tx.exec_status!=="ok")){persist(null);throw Error("Transaction failed. No successful action confirmed; prepare again if needed.");}
      if((tx.finality||tx.status)!=="HardFinal"){if(!pending.txId)persist({...pending,txId:id});setNotice("Waiting for HardFinal. No duplicate transaction sent.");return;}
      if(tx.exec_status!=="ok")throw Error("Execution success not confirmed.");
      const m=await checkedMarket();
      if(pending.method==="asset_probe"&&m.asset_verified!=="1")throw Error("Probe readback unavailable.");
      if(pending.method==="set_oracle"&&m.oracle!==ORACLE)throw Error("Oracle assignment readback differs.");
      if(pending.method==="activate"&&m.paused!=="0")throw Error("Activation readback differs.");
      persist(null);setRecovery("");setNotice(`${pending.method}: HardFinal, execution OK. Chỉ bước này đã hoàn tất.`);
    }catch(e){setNotice(errorText(e));}finally{lock.current=false;setBusy(false);}
  }
  const blocked=busy||!!pending||!loaded||wallet!==SETUP_OWNER||chain!==3;
  return <section className="lending-card"><h2>3. Kiểm tra RTD và cấp quyền cập nhật giá</h2>
    <p>Publisher được chỉ định (ví đã nạp 3 RTM test):</p><CopyValue value={ORACLE}/>
    <p>Approve chỉ cấp quyền 0.001 RTD. Probe chuyển 0.001 RTD vào và trả lại trong cùng giao dịch. Mỗi bước ký riêng, có phí RTM test.</p>
    <div className="actions"><button disabled={blocked||status?.asset_verified==="1"} onClick={()=>prepare("approve")}>Chuẩn bị Approve 0.001 RTD</button><button disabled={blocked||status?.asset_verified==="1"} onClick={()=>prepare("asset_probe")}>Chuẩn bị Probe RTD</button><button disabled={blocked||status?.oracle===ORACLE} onClick={()=>prepare("set_oracle")}>Chuẩn bị cấp quyền publisher</button><button disabled={blocked||status?.paused==="0"} onClick={()=>prepare("activate")}>Chuẩn bị Activate</button></div>
    {prepared&&<div className="preview"><p>Hành động: {prepared.method}. RTM gửi kèm: 0; chỉ trả phí mạng.</p><button className="primary" disabled={blocked} onClick={sign}>Ký {prepared.method}</button><button disabled={busy} onClick={()=>setPrepared(null)}>Hủy bản chuẩn bị</button></div>}
    {pending&&<div><p>Đang chờ: {pending.method}</p>{pending.txId?<CopyValue value={pending.txId}/>:<input aria-label="Recovery TX ID" placeholder="Dán TX từ lịch sử ví; không gửi lại" value={recovery} onChange={e=>setRecovery(e.target.value)}/>}</div>}
    <button disabled={busy||!loaded} onClick={check}>Kiểm tra TX / Refresh market</button>
    {status&&<p>Probe: {status.asset_verified==="1"?"OK":"chưa"} · Publisher: {status.oracle===ORACLE?"đúng ví":"chưa cấp"} · Giá: {status.price_fresh==="true"?"Fresh":"chưa cập nhật/hết hạn"} · Market: {status.paused==="0"?"Active":"Paused"}</p>}
    <p role="status" aria-live="polite">{notice}</p><p>Chỉ Activate sau khi worker xuất bản giá và xác minh HardFinal. Chưa thay cấu hình market trên Vercel.</p>
  </section>;
}
