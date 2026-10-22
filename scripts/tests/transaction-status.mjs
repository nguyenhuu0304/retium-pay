import './typescript.mjs';
import assert from 'node:assert/strict';
const {verifyDexTx}=await import('../../src/lib/transactions/verify.ts');
const {borrowAvailable,repayLimits}=await import('../../src/lib/lending/amounts.ts');
const {publicStatus}=await import('../../src/lib/transactions/public-status.ts');
const U=10n**18n,wallet='rete'+'a'.repeat(68),market='1'.repeat(64),id='tx_'+'b'.repeat(32),now=Date.now();
const plan={wallet,token:'2'.repeat(64),symbol:'RTD',action:'lending:borrow',call:{contractId:market,method:'borrow',args:[String(U)],amountAtomic:'0'},nonce:12,createdAt:now,expiresAt:now+60000,deadline:now+120000,summary:[],approval:false,lending:{market,marketCodeHash:'3'.repeat(64),asset:'2'.repeat(64),assetCodeHash:'4'.repeat(64)}};
const tx={tx_id:id,sender:wallet,recipient:market,action:'call',call:{contract:market,method:'borrow',args:[String(U)]},amount:'0',nonce:12,finality:'HardFinal',exec_status:'ok',exec_error:null,rejection_reason:null,timestamp:Math.floor(now/1000)};
const job={txId:id,wallet,plan};
assert.equal(verifyDexTx(tx,job),'confirmed');
assert.equal(verifyDexTx({...tx,exec_status:null},job),'pending');
assert.equal(verifyDexTx({...tx,exec_status:'error'},job),'failed');
assert.equal(verifyDexTx({...tx,finality:'Pending',exec_status:null},job),'pending');
for(const patch of [{sender:'rete'+'c'.repeat(68)},{nonce:13},{amount:'1'},{recipient:'f'.repeat(64)},{action:'transfer'},{call:{...tx.call,method:'approve'}},{call:{...tx.call,args:['1']}},{tx_id:'tx_'+'c'.repeat(32)}])assert.throws(()=>verifyDexTx({...tx,...patch},job));
// A different failed transaction cannot release a hold for the real submitted one.
assert.throws(()=>verifyDexTx({...tx,sender:'wrong',finality:'Failed'},job));
console.log('PASS shared verifier: sender, nonce, contract, method, arguments, amount, TX ID, execution and pending/failure separation.');
let observed=[];
const ticket=Buffer.from(JSON.stringify(plan)).toString('base64url')+'.'+'0'.repeat(64),oldFetch=globalThis.fetch;
globalThis.fetch=async url=>{observed.push(String(url));if(String(url).includes('/transaction/'))return Response.json(tx);const asset=String(url).endsWith(plan.lending.asset);return Response.json({contract_id:asset?plan.lending.asset:market,code_hash:asset?plan.lending.assetCodeHash:plan.lending.marketCodeHash});};
try{const status=await publicStatus(ticket,id,wallet);assert.equal(status.state,'confirmed');assert.equal(status.notice,'disabled');assert.ok(observed.every(u=>u.startsWith('https://rpc.retium.org/')));}
finally{globalThis.fetch=oldFetch;}
console.log('PASS direct public status verifies code hashes without a Telegram or History session.');
for(let k=1n;k<1000n;k++){
 const index=U+k*123456789012345n,owned=k*12345n,limit=100n*U,cash=1000n*U;
 const p={borrow_limit:String(limit),debt_shares:String(owned)};
 const m={price_fresh:'true',paused:'0',index:String(index),cash:String(cash)};
 const amount=borrowAvailable(p,m),shares=(amount*U+index-1n)/index;
 const future=index+index/1000000n+2n,debt=((owned+shares)*future+U-1n)/U;
 assert.ok(debt<=limit);assert.ok(amount<=cash);
}
const limits=repayLimits(U);assert.ok(limits.approval>=repayLimits(U+100000000n).required);
assert.equal(borrowAvailable({borrow_limit:String(U),debt_shares:'0'},{price_fresh:'false',paused:'0',index:String(U),cash:String(U)}),0n);
console.log('PASS 999 Max Borrow signing-time/rounding bounds and repayment allowance does not loop after accrual.');
