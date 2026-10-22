import fs from 'node:fs';
import assert from 'node:assert/strict';
const wasm=process.env.LENDING_TEST_WASM || new URL('../build/retium_lending.wasm',import.meta.url);
const mod=await WebAssembly.compile(fs.readFileSync(wasm));
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

// Distinct wallets: owner/lender A, borrower B, oracle/liquidator C.
await run('init',A,[TOKEN,HASH]);await reject('init',B,[TOKEN,HASH]);
await reject('activate',A);await reject('set_oracle',B,[C]);await reject('set_oracle',A,[A]);
await run('set_oracle',A,[C]);await reject('refresh_price',A,[String(time)]);
await reject('refresh_price',C,[String(time+1n)]);await reject('refresh_price',C,[String(time-120001n)]);
await run('refresh_price',C,[String(time)]);await reject('refresh_price',C,[String(time)]);
// Approve alone changes no lending position; probe is round-trip.
assert.equal((await run('position',A,[A],0n,true)).supplied,'0');
allowances.set(A,1000n*U);await run('asset_probe',A,[String(U/1000n)]);assert.equal(balances.get(A),1000n*U);
await run('activate');await run('supply',A,[String(100n*U)]);
await run('deposit_collateral',B,[],100n*U);await run('borrow',B,[String(40n*U)]);
let m=await run('market',A,[],0n,true),p=await run('position',B,[B],0n,true);
assert.equal(m.cash,String(60n*U));assert.equal(p.debt,String(40n*U));
await reject('borrow',B,[String(11n*U)]);await reject('withdraw_collateral',B,[String(30n*U)]);
await reject('withdraw',A,[String(100n*U)]);await reject('withdraw_collateral',C,[String(U)]);
// Transaction rollback after a token transfer failure preserves every ledger.
const snapshot=()=>JSON.stringify({s:[...state],t:[...balances].map(([k,v])=>[k,String(v)]),r:[...native].map(([k,v])=>[k,String(v)]),a:[...allowances].map(([k,v])=>[k,String(v)])});
let before=snapshot();fail=true;await reject('supply',A,[String(U)]);assert.equal(snapshot(),before);fail=false;
time+=900001n;await reject('borrow',B,[String(U)]);await reject('withdraw_collateral',B,[String(U)]);await reject('liquidate',C,[B,String(U)]);
await run('repay',B,[String(U)]); // stale oracle must not prevent repayment.
await run('pause');p=await run('position',B,[B],0n,true);await run('repay',B,[p.debt_shares]);
await run('withdraw_collateral',B,[String(100n*U)]);p=await run('position',A,[A],0n,true);await run('withdraw',A,[p.supply_shares]);
m=await run('market',A,[],0n,true);assert.equal(m.cash,'0');assert.equal(m.debt,'0');assert.equal(m.supply_shares,'0');
assert.equal((await run('position',B,[B],0n,true)).collateral,'0');
console.log('PASS two-wallet Supply -> collateral -> Borrow -> Repay -> withdraw collateral -> full Withdraw, stale/pause exits and rollback.');
// Interest is paid by the borrower and becomes withdrawable lender yield.
await run('refresh_price',C,[String(time)]);await run('activate');
await run('supply',A,[String(100n*U)]);await run('deposit_collateral',B,[],100n*U);await run('borrow',B,[String(40n*U)]);
time+=31536000000n;p=await run('position',B,[B],0n,true);
assert.ok(BigInt(p.debt)>=42n*U-1000n&&BigInt(p.debt)<=42n*U);
const lenderBefore=balances.get(A);await run('repay',B,[p.debt_shares]);p=await run('position',A,[A],0n,true);await run('withdraw',A,[p.supply_shares]);
assert.ok(balances.get(A)-lenderBefore>=102n*U-1000n&&balances.get(A)-lenderBefore<=102n*U);
await run('withdraw_collateral',B,[String(100n*U)]);
console.log('PASS one-year interest accrual: borrower pays approximately 2 RTD and lender withdraws approximately 102 RTD.');
// Constant Safehouse rate: interest alone eventually makes an unpaid loan liquidatable.
await run('refresh_price',C,[String(time)]);await run('supply',A,[String(100n*U)]);await run('deposit_collateral',B,[],100n*U);await reject('borrow',B,[String(50n*U)]);await run('borrow',B,[String(49n*U)]);
await reject('liquidate',C,[B,String(U)]);
time+=9n*31536000000n;await run('refresh_price',C,[String(time)]);p=await run('position',B,[B],0n,true);
assert.ok(BigInt(p.debt)>70n*U);await reject('liquidate',C,[B,p.debt_shares]);
const oldCollateral=BigInt(p.collateral), liquidatorBefore=native.get(C);
await run('liquidate',C,[B,String(BigInt(p.debt_shares)/2n)]);
p=await run('position',B,[B],0n,true);assert.ok(BigInt(p.collateral)<oldCollateral);assert.ok(native.get(C)>liquidatorBefore);
await run('repay',B,[p.debt_shares]);await run('withdraw_collateral',B,[p.collateral]);p=await run('position',A,[A],0n,true);await run('withdraw',A,[p.supply_shares]);
m=await run('market',A,[],0n,true);assert.equal(m.debt,'0');assert.equal(m.cash,'0');
console.log('PASS healthy-position protection, 50% liquidation close factor, collateral payout and complete cleanup.');
await run('set_oracle',A,[B]);assert.equal((await run('market',A,[],0n,true)).price_fresh,'false');await reject('refresh_price',C,[String(time)]);await run('refresh_price',B,[String(time)]);
liveHash='4'.repeat(64);await reject('supply',A,[String(U)]);liveHash=HASH;
await reject('supply',A,['340282366920938463463374607431768211456']);await reject('market',A,[],U);
console.log(`PASS total ${checks} WASM lifecycle calls, refusal and ownership checks. No real wallet, network transaction or token used.`);
