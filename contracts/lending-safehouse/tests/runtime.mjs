import fs from 'node:fs';
import assert from 'node:assert/strict';
const mod=await WebAssembly.compile(fs.readFileSync(new URL('../build/retium_lending.wasm',import.meta.url)));
const U=10n**18n,A='rete'+'a'.repeat(68),B='rete'+'b'.repeat(68),C='rete'+'c'.repeat(68),SELF='1'.repeat(64),TOKEN='2'.repeat(64),HASH='3'.repeat(64);
let state=new Map(),balances=new Map([[A,1000n*U],[B,1000n*U],[C,1000n*U],[SELF,0n]]),native=new Map([[A,1000n*U],[B,1000n*U],[C,1000n*U],[SELF,0n]]),time=1800000000000n,fail=false,liveHash=HASH;
let allowances=new Map([[A,0n],[B,1000n*U],[C,1000n*U]]);
const enc=new TextEncoder(),dec=new TextDecoder();let checks=0;
async function run(action,caller=A,args=[],value=0n,view=false){
 const old=[new Map(state),new Map(balances),new Map(native),new Map(allowances)];let instance;
 const read=(p,n)=>dec.decode(new Uint8Array(instance.exports.memory.buffer,p,n));
 const write=(p,s,max=4096)=>{const b=enc.encode(s);assert.ok(b.length<=max);new Uint8Array(instance.exports.memory.buffer,p,b.length).set(b);return b.length;};
 const env={read_state:(p,n,o,m)=>write(o,state.get(read(p,n))||'',m),write_state:(p,n,v,l)=>state.set(read(p,n),read(v,l)),emit_event:()=>0,get_block_time:()=>time,get_self_contract_id:(o,m)=>write(o,SELF,m),get_contract_code_hash:(p,n,o,m)=>write(o,liveHash,m),call_contract:(p,n,q,l,a,k,o,m)=>{const contract=read(p,n),method=read(q,l),args=JSON.parse(read(a,k));if(contract==='RTM_NATIVE'){let amount=BigInt(args[1]);assert.ok(native.get(SELF)>=amount);native.set(SELF,native.get(SELF)-amount);native.set(args[0],(native.get(args[0])||0n)+amount);return write(o,fail?' {"error":"failed"} '.trim():'ok',m);}assert.equal(contract,TOKEN);if(method==='balance_of')return write(o,String(balances.get(args[0])||0n),m);let from=method==='transfer_from'?args[0]:SELF,to=method==='transfer_from'?args[1]:args[0],amount=BigInt(args.at(-1));if(method==='transfer_from'){assert.ok((allowances.get(from)||0n)>=amount);allowances.set(from,allowances.get(from)-amount);}assert.ok((balances.get(from)||0n)>=amount);balances.set(from,balances.get(from)-amount);balances.set(to,(balances.get(to)||0n)+amount);return write(o,fail?'{"ok":false}':'ok',m);}};
 try{instance=await WebAssembly.instantiate(mod,{env});const input=enc.encode(JSON.stringify({action,caller,args,value:String(value),token_context:null}));new Uint8Array(instance.exports.memory.buffer,0,input.length).set(input);native.set(caller,(native.get(caller)||0n)-value);native.set(SELF,native.get(SELF)+value);const p=input.length+1024,n=instance.exports.on_use(0,input.length,p);const result=JSON.parse(read(p,n));if(view)[state,balances,native,allowances]=old;checks++;return result;}catch(e){[state,balances,native,allowances]=old;throw e;}
}
const reject=async(...args)=>{await assert.rejects(()=>run(...args));checks++;};
await run('init',A,[TOKEN,HASH]);
await reject('set_oracle',B,[C]);await reject('set_oracle',A,[A]);
await run('set_oracle',A,[C]);await reject('set_price',A,[String(U)]);
await reject('refresh_price',A,[String(time)]);await reject('refresh_price',C,[String(time+1n)]);
await reject('refresh_price',C,[String(time-120001n)]);await reject('refresh_price',C,['18000000x0000']);
await run('refresh_price',C,[String(time)]);await reject('refresh_price',C,[String(time)]);
allowances.set(A,1000n*U);await run('asset_probe',A,[String(U)]);await run('activate');
await run('supply',A,[String(100n*U)]);await run('deposit_collateral',B,[],100n*U);await run('borrow',B,[String(40n*U)]);
time+=900001n;await reject('borrow',B,[String(U)]);await run('repay',B,[String(U)]);
await run('refresh_price',C,[String(time)]);await run('borrow',B,[String(U)]);
await run('set_oracle',A,[B]);assert.equal((await run('market',A,[],0n,true)).price_fresh,'false');
await reject('refresh_price',C,[String(time)]);await run('refresh_price',B,[String(time)]);
const m=await run('market',A,[],0n,true);assert.equal(m.price,String(U));assert.equal(m.oracle,B);assert.equal(m.oracle_mode,'safehouse_reference_feed');
console.log(`PASS ${checks} WASM oracle role, stale/future/replay refusal, fixed rate, rotation invalidation, borrow blocking and repay availability checks.`);
