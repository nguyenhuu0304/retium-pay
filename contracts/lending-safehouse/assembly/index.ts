// Retium Pay isolated lending TESTNET prototype. All state persists through host storage.
// Contract-specific market roles and risks are documented in README.md.
import { JSON } from "assemblyscript-json/assembly";
import { u128 } from "as-bignum/assembly";
import { ZERO, ONE, UNIT, CAP, add, sub, strict, mulDiv, min } from "./math";
@external("env","read_state") declare function read_state(k:usize,kl:i32,o:usize,om:i32):i32;
@external("env","write_state") declare function write_state(k:usize,kl:i32,v:usize,vl:i32):void;
@external("env","emit_event") declare function emit_event(t:usize,tl:i32,d:usize,dl:i32):i32;
@external("env","get_block_time") declare function get_block_time():i64;
@external("env","get_self_contract_id") declare function get_self_contract_id(o:usize,m:i32):i32;
@external("env","get_contract_code_hash") declare function get_contract_code_hash(c:usize,cl:i32,o:usize,om:i32):i32;
@external("env","call_contract") declare function call_contract(c:usize,cl:i32,m:usize,ml:i32,a:usize,al:i32,o:usize,om:i32):i32;
// RCP metadata injected deterministically by scripts/metadata.mjs before compilation.
// METADATA_START
export const RCP_METADATA:usize=memory.data<u8>([82,67,80,95,77,69,84,65,68,65,84,65,58,123,34,114,99,112,95,116,121,112,101,34,58,34,114,101,116,105,117,109,112,97,121,95,108,101,110,100,105,110,103,95,116,101,115,116,34,44,34,116,114,97,105,116,115,34,58,91,34,116,101,115,116,110,101,116,34,44,34,108,101,110,100,105,110,103,34,44,34,115,97,102,101,104,111,117,115,101,95,114,101,102,101,114,101,110,99,101,95,102,101,101,100,34,93,44,34,99,97,112,97,98,105,108,105,116,105,101,115,34,58,91,34,101,120,101,99,117,116,101,34,93,44,34,108,111,99,107,97,98,108,101,95,102,105,101,108,100,115,34,58,91,93,44,34,101,118,111,108,118,101,115,95,102,114,111,109,34,58,34,34,44,34,119,101,105,103,104,116,34,58,53,44,34,118,101,114,115,105,111,110,34,58,34,118,48,46,50,46,48,34,125,0]);
// METADATA_END
const BPS=u128.fromU32(10000), LTV=u128.fromU32(5000), LIQ=u128.fromU32(7000), BONUS=u128.fromU32(10500);
const RATE=u128.fromU32(500), YEAR_MS:u64=31536000000, PRICE_TTL:u64=900000;
const MIN_LOAN=u128.fromString("1000000000000000");
function q(s:string):string{return JSON.Value.String(s).stringify();}
function obj(pairs:string[]):string{let s="{";for(let i=0;i<pairs.length;i+=2){if(i)s+=",";s+=q(pairs[i])+":"+q(pairs[i+1]);}return s+"}";}
function str(o:JSON.Obj,k:string):string{const s=o.getString(k);if(s===null)unreachable();return s!.valueOf();}
function get(k:string):string{const a=String.UTF8.encode(k),b=new ArrayBuffer(4096);const n=read_state(changetype<usize>(a),a.byteLength,changetype<usize>(b),b.byteLength);if(n<0||n>=4096)unreachable();return n==0?"":String.UTF8.decodeUnsafe(changetype<usize>(b),n);}
function set(k:string,v:string):void{const a=String.UTF8.encode(k),b=String.UTF8.encode(v);write_state(changetype<usize>(a),a.byteLength,changetype<usize>(b),b.byteLength);}
function number(k:string):u128{const s=get(k);return s.length?strict(s):ZERO;}
function save(k:string,v:u128):void{set(k,v.toString());}
function emit(action:string,who:string,amount:u128):void{const t=String.UTF8.encode("lending_"+action),d=String.UTF8.encode(obj(["account",who,"amount",amount.toString()]));if(emit_event(changetype<usize>(t),t.byteLength,changetype<usize>(d),d.byteLength)<0)unreachable();}
function now():u64{const t=get_block_time();if(t<=0)unreachable();return <u64>t;}
function self():string{const b=new ArrayBuffer(128);const n=get_self_contract_id(changetype<usize>(b),128);if(n!=64)unreachable();return String.UTF8.decodeUnsafe(changetype<usize>(b),n);}
function hash(c:string):string{const a=String.UTF8.encode(c),b=new ArrayBuffer(128);const n=get_contract_code_hash(changetype<usize>(a),a.byteLength,changetype<usize>(b),128);if(n!=64)unreachable();return String.UTF8.decodeUnsafe(changetype<usize>(b),n);}
function hex(s:string,n:i32):bool{if(s.length!=n)return false;for(let i=0;i<n;i++){const c=s.charCodeAt(i);if(!((c>=48&&c<=57)||(c>=97&&c<=102)))return false;}return true;}
function wallet(s:string):bool{return s.startsWith("rete")&&hex(s.substring(4),68);}
function xcall(c:string,m:string,args:string[]):string{const a=String.UTF8.encode(c),b=String.UTF8.encode(m);let raw="[";for(let i=0;i<args.length;i++){if(i)raw+=",";raw+=q(args[i]);}raw+="]";const v=String.UTF8.encode(raw),out=new ArrayBuffer(4096);const n=call_contract(changetype<usize>(a),a.byteLength,changetype<usize>(b),b.byteLength,changetype<usize>(v),v.byteLength,changetype<usize>(out),4096);if(n<0||n>4096)unreachable();const reply=String.UTF8.decodeUnsafe(changetype<usize>(out),n);if(reply.startsWith("{")){const p=JSON.parse<string>(reply);if(!(p instanceof JSON.Obj))unreachable();const o=<JSON.Obj>p;const success=o.getBool("ok");if(o.has("error")||(success!==null&&!success.valueOf()))unreachable();}return reply;}
function tokenCheck():void{if(hash(get("asset"))!=get("asset_hash"))unreachable();}
function tokenBalanceOf(who:string):u128{let s=xcall(get("asset"),"balance_of",[who]).trim();if(s.startsWith('"')&&s.endsWith('"'))s=s.substring(1,s.length-1);return strict(s);}
function tokenBalance():u128{return tokenBalanceOf(self());}
function receiveToken(from:string,amount:u128):void{tokenCheck();const before=tokenBalance();xcall(get("asset"),"transfer_from",[from,self(),amount.toString()]);if(tokenBalance()!=add(before,amount))unreachable();}
function sendToken(to:string,amount:u128):void{tokenCheck();const before=tokenBalance(),recipientBefore=tokenBalanceOf(to);xcall(get("asset"),"transfer",[to,amount.toString()]);if(tokenBalance()!=sub(before,amount)||tokenBalanceOf(to)!=add(recipientBefore,amount))unreachable();}
function sendRtm(to:string,amount:u128):void{if(amount>ZERO)xcall("RTM_NATIVE","transfer",[to,amount.toString()]);}
function indexAt(t:u64):u128{const index=number("index"),last=<u64>U64.parseInt(get("last_accrual"));if(t<last)unreachable();const delta=u128.fromU64(t-last);return add(index,mulDiv(index,mulDiv(RATE,delta,ONE),u128.fromU64(YEAR_MS)*BPS));}
function accrue(t:u64):u128{const i=indexAt(t);save("index",i);set("last_accrual",t.toString());return i;}
function debt(shares:u128,index:u128):u128{return mulDiv(shares,index,UNIT,true);}
function fresh(t:u64):bool{const raw=get("price_at");if(raw.length==0)return false;const at=U64.parseInt(raw);return t>=at&&t-at<=PRICE_TTL&&number("price")>ZERO;}
function value(collateral:u128):u128{return mulDiv(collateral,number("price"),UNIT);}
function assets(index:u128):u128{return add(number("cash"),debt(number("debt_shares"),index));}
function active():bool{return get("paused")=="0"&&get("asset_verified")=="1";}
function err(code:string):string{return '{"ok":false,"error":'+q(code)+'}';}
function ack(action:string,who:string,amount:u128):string{emit(action,who,amount);return '{"ok":true,"action":'+q(action)+',"amount":'+q(amount.toString())+'}';}
function health(collateral:u128,owed:u128):string{return owed==ZERO?"none":mulDiv(mulDiv(value(collateral),LIQ,BPS),UNIT,owed).toString();}
function handle(action:string,caller:string,args:string[],attached:u128):string{
 if(!wallet(caller)&&action!="market"&&action!="position"&&action!="owner")return err("WALLET_CALLER_REQUIRED");
 if(action=="init"){
  if(get("owner").length)return err("ALREADY_INITIALIZED");
  if(args.length!=2||!hex(args[0],64)||!hex(args[1],64)||attached!=ZERO)return err("INVALID_INIT");
  if(hash(args[0])!=args[1])return err("ASSET_CODE_HASH_MISMATCH");
  set("owner",caller);set("asset",args[0]);set("asset_hash",args[1]);set("paused","1");set("asset_verified","0");save("index",UNIT);set("last_accrual",now().toString());return ack(action,caller,ZERO);
 }
 if(get("owner").length==0)return err("NOT_INITIALIZED");
 if(action!="deposit_collateral"&&attached!=ZERO)return err("UNEXPECTED_RTM");
 const t=now();
 if(action=="owner")return '{"ok":true,"data":'+q(get("owner"))+'}';
 if(action=="market"||action=="position"){
  const index=indexAt(t),cash=number("cash"),borrowed=debt(number("debt_shares"),index),total=add(cash,borrowed),supply=number("supply_shares");
  if(action=="market")return obj(["version","v0.2.0","testnet_only","true","oracle_mode","safehouse_reference_feed","oracle",get("oracle"),"price_source","Retium Safehouse 1 RTM = 1 RTD","owner",get("owner"),"asset",get("asset"),"asset_hash",get("asset_hash"),"asset_verified",get("asset_verified"),"paused",get("paused"),"cash",cash.toString(),"debt",borrowed.toString(),"assets",total.toString(),"supply_shares",supply.toString(),"debt_shares",number("debt_shares").toString(),"index",index.toString(),"price",number("price").toString(),"price_at",get("price_at"),"price_fresh",fresh(t)?"true":"false","price_ttl_ms",PRICE_TTL.toString(),"borrow_apr_bps","500","ltv_bps","5000","liquidation_bps","7000","liquidation_bonus_bps","500","min_loan",MIN_LOAN.toString(),"cap",CAP.toString(),"block_time_ms",t.toString()]);
  if(args.length!=1||!wallet(args[0]))return err("INVALID_ACCOUNT");const who=args[0],c=number("collateral:"+who),d=number("borrow:"+who),ss=number("supply:"+who);
  return obj(["account",who,"collateral",c.toString(),"debt_shares",d.toString(),"debt",debt(d,index).toString(),"supply_shares",ss.toString(),"supplied",supply==ZERO?"0":mulDiv(ss,total,supply).toString(),"borrow_limit",mulDiv(value(c),LTV,BPS).toString(),"health_factor",health(c,debt(d,index)),"price_fresh",fresh(t)?"true":"false"]);
 }
 // Only the dedicated publisher can attest to a recent Safehouse check.
 if(action=="set_oracle"){
  if(caller!=get("owner"))return err("OWNER_ONLY");
  if(args.length!=1||!wallet(args[0])||args[0]==caller)return err("SEPARATE_ORACLE_WALLET_REQUIRED");
  set("oracle",args[0]);set("price_at","");save("price",ZERO);return ack(action,caller,ZERO);
 }
 if(action=="refresh_price"){
  if(caller!=get("oracle"))return err("ORACLE_ONLY");
  if(args.length!=1||args[0].length!=13)return err("INVALID_OBSERVATION_TIME");
  // strict rejects non-digits; constrain before narrowing to u64.
  const raw=strict(args[0]);
  if(raw>u128.fromU64(t))return err("FUTURE_OBSERVATION");
  const observed=U64.parseInt(args[0]);
  if(t-observed>120000)return err("STALE_OBSERVATION");
  const previous=get("price_at");
  if(previous.length&&observed<=U64.parseInt(previous))return err("OBSERVATION_NOT_NEWER");
  save("price",UNIT);set("price_at",args[0]);return ack(action,caller,UNIT);
 }
 if(action=="set_price")return err("USE_SAFEHOUSE_ORACLE");
 if(action=="activate"||action=="pause"||action=="asset_probe"){
  if(caller!=get("owner"))return err("OWNER_ONLY");
  if(action=="pause"){set("paused","1");return ack(action,caller,ZERO);}
  if(action=="activate"){if(get("asset_verified")!="1"||!fresh(t))return err("PROBE_AND_FRESH_PRICE_REQUIRED");set("paused","0");return ack(action,caller,ZERO);}
  if(number("supply_shares")!=ZERO||number("debt_shares")!=ZERO||number("collateral_total")!=ZERO)return err("PROBE_EMPTY_MARKET_ONLY");
  if(args.length!=1)return err("INVALID_ARGS");const a=strict(args[0]);if(a==ZERO||a>UNIT)return err("PROBE_AMOUNT_LIMIT");receiveToken(caller,a);sendToken(caller,a);set("asset_verified","1");return ack(action,caller,a);
 }
 const index=accrue(t);
 if(action=="deposit_collateral"){
  if(args.length!=0||attached==ZERO||attached>CAP)return err("INVALID_COLLATERAL");const c=add(number("collateral:"+caller),attached),all=add(number("collateral_total"),attached);if(all>CAP)return err("COLLATERAL_CAP");save("collateral:"+caller,c);save("collateral_total",all);return ack(action,caller,attached);
 }
 if(action=="withdraw_collateral"){
  if(args.length!=1)return err("INVALID_ARGS");const a=strict(args[0]),c=number("collateral:"+caller),owed=debt(number("borrow:"+caller),index);if(a==ZERO||a>c)return err("INSUFFICIENT_COLLATERAL");
  if(owed>ZERO&&(!fresh(t)||owed>mulDiv(value(c-a),LTV,BPS)))return err("COLLATERAL_REQUIRED_OR_PRICE_STALE");save("collateral:"+caller,c-a);save("collateral_total",sub(number("collateral_total"),a));sendRtm(caller,a);return ack(action,caller,a);
 }
 if(action=="supply"){
  if(!active())return err("MARKET_PAUSED");if(args.length!=1)return err("INVALID_ARGS");const a=strict(args[0]);if(a==ZERO||a>CAP)return err("INVALID_AMOUNT");const total=assets(index),ss=number("supply_shares"),minted=ss==ZERO?a:mulDiv(a,ss,total);if(minted==ZERO||add(total,a)>CAP)return err("DUST_OR_MARKET_CAP");
  receiveToken(caller,a);save("cash",add(number("cash"),a));save("supply_shares",add(ss,minted));save("supply:"+caller,add(number("supply:"+caller),minted));return ack(action,caller,a);
 }
 if(action=="withdraw"){
  if(args.length!=1)return err("INVALID_ARGS");const shares=strict(args[0]),owned=number("supply:"+caller),all=number("supply_shares");if(shares==ZERO||shares>owned||all==ZERO)return err("INSUFFICIENT_SHARES");const a=mulDiv(shares,assets(index),all);if(a==ZERO||a>number("cash"))return err("INSUFFICIENT_LIQUIDITY");
  save("cash",sub(number("cash"),a));save("supply_shares",sub(all,shares));save("supply:"+caller,owned-shares);sendToken(caller,a);return ack(action,caller,a);
 }
 if(action=="borrow"){
  if(!active())return err("MARKET_PAUSED");if(!fresh(t))return err("PRICE_STALE");if(args.length!=1)return err("INVALID_ARGS");const a=strict(args[0]);if(a<MIN_LOAN||a>number("cash"))return err("AMOUNT_OR_LIQUIDITY");const shares=mulDiv(a,UNIT,index,true),next=add(number("borrow:"+caller),shares);
  if(debt(next,index)>mulDiv(value(number("collateral:"+caller)),LTV,BPS))return err("BORROW_LIMIT");save("borrow:"+caller,next);save("debt_shares",add(number("debt_shares"),shares));save("cash",sub(number("cash"),a));sendToken(caller,a);return ack(action,caller,a);
 }
 if(action=="repay"){
  if(args.length!=1)return err("INVALID_ARGS");const shares=strict(args[0]),owned=number("borrow:"+caller);if(shares==ZERO||shares>owned)return err("INVALID_DEBT_SHARES");const a=debt(shares,index);receiveToken(caller,a);save("cash",add(number("cash"),a));save("borrow:"+caller,owned-shares);save("debt_shares",sub(number("debt_shares"),shares));return ack(action,caller,a);
 }
 if(action=="liquidate"){
  if(!fresh(t))return err("PRICE_STALE");if(args.length!=2||!wallet(args[0])||args[0]==caller)return err("INVALID_LIQUIDATION");const who=args[0],shares=strict(args[1]),owned=number("borrow:"+who),c=number("collateral:"+who),owed=debt(owned,index);
  if(owed==ZERO||owed<=mulDiv(value(c),LIQ,BPS))return err("POSITION_HEALTHY");
  if(shares==ZERO||shares>mulDiv(owned,u128.fromU32(5000),BPS,true))return err("CLOSE_FACTOR_LIMIT");const a=debt(shares,index),seized=mulDiv(mulDiv(a,BONUS,BPS,true),UNIT,number("price"),true);if(seized>c||seized==ZERO)return err("INSUFFICIENT_COLLATERAL_FOR_LIQUIDATION");
  receiveToken(caller,a);save("cash",add(number("cash"),a));save("debt_shares",sub(number("debt_shares"),shares));save("borrow:"+who,owned-shares);save("collateral:"+who,c-seized);save("collateral_total",sub(number("collateral_total"),seized));sendRtm(caller,seized);return ack(action,who,a);
 }
 return err("UNKNOWN_ACTION");
}
export function on_use(inputPtr:i32,inputLen:i32,outputPtr:i32):i32{
 if(inputLen<=0||inputLen>16384)unreachable();
 const raw=String.UTF8.decodeUnsafe(inputPtr,inputLen), parsed=JSON.parse<string>(raw);if(!(parsed instanceof JSON.Obj))unreachable();const o=<JSON.Obj>parsed;
 const action=str(o,"action"),providedCaller=o.getString("caller"),caller=providedCaller===null?"":providedCaller.valueOf(),v=o.getString("value"),a=o.getArr("args");if(a===null)unreachable();const arr=a!.valueOf();if(arr.length>4)unreachable();const args=new Array<string>();for(let i=0;i<arr.length;i++){if(!(arr[i] instanceof JSON.Str))unreachable();const s=(<JSON.Str>arr[i]).valueOf();if(s.length>256)unreachable();args.push(s);}
 // Any refusal traps, so a caller contract cannot swallow an error after writes.
 const reply=handle(action,caller,args,v===null?ZERO:strict(v.valueOf()));
 if(reply.indexOf('"ok":false')==1)unreachable();
 const bytes=String.UTF8.encode(reply);if(bytes.byteLength>4096)unreachable();memory.copy(outputPtr,changetype<usize>(bytes),bytes.byteLength);return bytes.byteLength;
}
