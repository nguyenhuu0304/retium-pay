import type { LendingConfig } from "./config";
import { snapshot, readPublic } from "./browser";
import { SETUP_OWNER, SETUP_HASH, SETUP_ASSET, SETUP_ASSET_HASH } from "./setup-safehouse";
export const SAFEHOUSE_RATE="1000000000000000000";
export type RefreshIntent = { wallet:string; market:string; nonce:number; observed:string; until:number; txId:string };
export function validateSafehouseReference(s: Record<string,unknown>) {
  if(s.safehouse!=="rete_safehouse" || s.rusd_contract_id!==SETUP_ASSET || s.rusd_deployed!==true)throw Error("Safehouse identity mismatch. No update prepared.");
  const integer=(key:string)=>{const v=s[key];if(typeof v!=="string"||!/^\d{1,39}$/.test(v))throw Error("Invalid Safehouse reserve figures.");return BigInt(v);};
  const inventory=integer("inventory_atomic"),locked=integer("locked_atomic"),released=integer("released_atomic"),burned=integer("burned_atomic"),total=integer("total_supply_atomic");
  if(total!==1000000000n*10n**18n || inventory<=0n || inventory>total || released>total || burned>released || locked<released-burned)throw Error("Safehouse reference unavailable. No update prepared.");
  return SAFEHOUSE_RATE;
}
export function validateRefreshIntent(value: unknown, wallet:string, market:string): RefreshIntent {
  const p=value as RefreshIntent;
  if(!p || p.wallet!==wallet || p.market!==market || !Number.isSafeInteger(p.nonce) || p.nonce<0 || !/^\d{13}$/.test(p.observed) || !Number.isSafeInteger(p.until) || typeof p.txId!=="string" || (p.txId!==""&&!/^tx_[a-f0-9]{32}$/.test(p.txId)))throw Error("Saved oracle update is invalid. Check wallet history before signing.");
  return p;
}
export async function prepareSafehouseRefresh(c:LendingConfig,wallet:string,chain:number): Promise<RefreshIntent> {
  if(chain!==3 || c.marketCodeHash!==SETUP_HASH || c.asset!==SETUP_ASSET || c.assetCodeHash!==SETUP_ASSET_HASH)throw Error("Unsupported Safehouse market or network.");
  const state=await snapshot(c,wallet),m=state.market;
  if(m.version!=="v0.2.0"||m.oracle_mode!=="safehouse_reference_feed"||m.owner!==SETUP_OWNER||m.oracle!==wallet||wallet===SETUP_OWNER||m.asset_verified!=="1")throw Error("Connect the oracle wallet shown on this market to refresh its price.");
  if(state.rtmBalance===null)throw Error("RTM balance unavailable. Refresh and retry.");
  if(BigInt(state.rtmBalance)<600000000000000000n)throw Error("Keep at least 0.6 RTM in the oracle wallet for the refresh fee and reserve.");
  const source=await readPublic("safehouse");
  validateSafehouseReference(source);
  const observed=Date.now();
  if(!/^\d{13}$/.test(String(observed)) || !/^\d{13}$/.test(m.block_time_ms) || Math.abs(observed-Number(m.block_time_ms))>60000)throw Error("Device clock differs from chain time. Update your clock and prepare again.");
  return {wallet,market:c.market,nonce:state.nonce,observed:String(observed),until:observed+45000,txId:""};
}
export function checkedRefreshTx(tx:Record<string,unknown>,p:RefreshIntent): "pending"|"failed"|"confirmed" {
  const call=tx.call as {contract?:unknown;method?:unknown;args?:unknown}|null;
  if(tx.tx_id!==p.txId||tx.sender!==p.wallet||tx.recipient!==p.market||tx.nonce!==p.nonce||tx.action!=="call"||tx.amount!=="0"||call?.contract!==p.market||call?.method!=="refresh_price")throw Error("TX does not match this oracle refresh. Enter the refresh_price TX, not an approval or lending TX.");
  if(call.args!==undefined){const args=Array.isArray(call.args)?call.args.map(String).join(","):call.args;if(args!==p.observed)throw Error("Oracle observation time differs from the saved update.");}
  const finality=tx.finality||tx.status;
  if(["Failed","Rejected","Voided"].includes(String(finality)))return "failed";
  if(finality!=="HardFinal")return "pending";
  if(tx.exec_error||tx.rejection_reason||(tx.exec_status&&tx.exec_status!=="ok"))return "failed";
  return tx.exec_status==="ok"?"confirmed":"pending";
}
