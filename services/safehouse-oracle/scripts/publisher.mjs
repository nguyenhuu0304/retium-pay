import { validateSafehouse, RATE, ASSET } from './source.mjs';
export const OWNER='retef25ddec9d77f15810718a59551061df10024179bc6da4952432f236448575a88cb37';
export const ASSET_HASH='5c6b3392d5f3769522befe48cb5dc53db3e633e2f3a63f29abba74433ef768a2';
const txPattern=/^tx_[a-f0-9]{32}$/;
function ensure(ok,code){if(!ok)throw Error(code);}
export function validateState(state,config){
  ensure(state&&typeof state==='object'&&!Array.isArray(state),'INVALID_STATE');
  ensure(!state.market||state.market===config.market,'STATE_BELONGS_TO_ANOTHER_MARKET');
  if(state.last!==undefined)ensure(Number.isSafeInteger(state.last)&&state.last>=0,'INVALID_STATE');
  if(state.attempts!==undefined)ensure(Number.isSafeInteger(state.attempts)&&state.attempts>=0,'INVALID_STATE');
  if(state.pending){const p=state.pending;ensure(/^\d{13}$/.test(p.observed)&&Number.isSafeInteger(p.nonce)&&p.nonce>=0&&typeof p.txId==='string'&&(!p.txId||txPattern.test(p.txId)),'INVALID_PENDING_STATE');}
}
export function createPublisher({config,readJson,cli,store,now=Date.now,log=()=>{}}){
  const {market,codeHash,oracle}=config;let busy=false;
  ensure(/^[a-f0-9]{64}$/.test(market)&&/^[a-f0-9]{64}$/.test(codeHash)&&/^rete[a-f0-9]{68}$/.test(oracle)&&oracle!==OWNER,'CONFIGURATION_REQUIRED');
  async function marketCheck(){
    const [info,raw,asset]=await Promise.all([readJson('/api/contract/'+market),readJson('/api/contract/'+market+'/query?method=market&args='),readJson('/api/contract/'+ASSET)]);
    ensure(info.contract_id===market&&info.code_hash===codeHash&&info.status==='deployed','MARKET_CODE_MISMATCH');
    ensure(asset.contract_id===ASSET&&asset.code_hash===ASSET_HASH,'ASSET_CODE_MISMATCH');
    ensure(raw.ok===true&&raw.contract_id===market&&raw.method==='market','MARKET_QUERY_FAILED');
    const m=JSON.parse(raw.output);
    ensure(m.version==='v0.2.0'&&m.oracle_mode==='safehouse_reference_feed'&&m.asset===ASSET&&m.asset_hash===ASSET_HASH&&m.oracle===oracle&&m.owner===OWNER&&m.asset_verified==='1','ORACLE_ROLE_MISMATCH');
    ensure(/^\d{1,13}$/.test(m.price_at||'0')&&Number(m.price_at||0)<=now()+30000,'INVALID_MARKET_PRICE_TIME');
    return m;
  }
  async function inner(){
    let state=await store.load();validateState(state,config);
    ensure(!state.halted,'PUBLISHER_HALTED_REVIEW_REQUIRED');
    const m=await marketCheck();
    if(state.pending){
      const p=state.pending;ensure(p.txId,'UNKNOWN_SUBMISSION_STOPPED_FOR_MANUAL_RECOVERY');
      const tx=await readJson('/api/transaction/'+p.txId),finality=tx.finality||tx.status;
      ensure(tx.tx_id===p.txId&&tx.sender===oracle&&tx.recipient===market&&tx.action==='call'&&tx.call?.contract===market&&tx.call?.method==='refresh_price'&&tx.amount==='0'&&tx.nonce===p.nonce,'TRANSACTION_IDENTITY_MISMATCH');
      if(tx.call.args!==undefined){const args=Array.isArray(tx.call.args)?tx.call.args.map(String).join(','):tx.call.args;ensure(args===p.observed,'PUBLISHED_ARGUMENT_MISMATCH');}
      if(['Rejected','Voided','Failed'].includes(finality)||tx.exec_error||tx.rejection_reason||(tx.exec_status&&tx.exec_status!=='ok')){
        state.halted='FAILED_PUBLISH_REVIEW_REQUIRED';await store.save(state);throw Error('FAILED_PUBLISH_REVIEW_REQUIRED');
      }
      if(finality!=='HardFinal'){log('Publisher TX pending. No duplicate sent.');return 'pending';}
      ensure(tx.exec_status==='ok','EXECUTION_NOT_CONFIRMED');
      ensure(m.price===RATE&&Number(m.price_at)>=Number(p.observed),'PRICE_READBACK_FAILED');
      state={...state,last:Number(m.price_at)};delete state.pending;await store.save(state);
      log('Safehouse reference refresh confirmed HardFinal.');return 'confirmed';
    }
    // Chain time, not only a process timer, prevents duplicate refreshes after restart.
    const last=Math.max(state.last||0,Number(m.price_at||0));
    if(now()-last<300000){log('Price update not due yet. No transaction sent.');return 'not_due';}
    const day=new Date(now()).toISOString().slice(0,10);
    if(state.day!==day)state={...state,day,attempts:0};
    ensure((state.attempts||0)<288,'DAILY_PUBLISH_LIMIT');
    const balance=JSON.parse(await cli(['--json','balance']));
    ensure(balance.address===oracle&&Number.isSafeInteger(balance.next_nonce)&&balance.next_nonce>=0,'SIGNER_ADDRESS_MISMATCH');
    ensure(typeof balance.balance_rtm==='string'&&/^\d+(\.\d{1,18})?$/.test(balance.balance_rtm),'INVALID_SIGNER_BALANCE');
    const [whole,fraction='']=balance.balance_rtm.split('.');
    ensure(BigInt(whole)*10n**18n+BigInt(fraction.padEnd(18,'0'))>=600000000000000000n,'ORACLE_GAS_LOW');
    validateSafehouse(await readJson('/api/safehouse'));
    const observed=String(now());ensure(/^\d{13}$/.test(observed),'CLOCK_UNAVAILABLE');
    state={...state,market,attempts:(state.attempts||0)+1,pending:{observed,nonce:balance.next_nonce,txId:''}};
    // Durable intent before signing; any unknown outcome blocks subsequent submissions.
    await store.save(state);
    const out=await cli(['call',market,'refresh_price',observed]);
    const ids=[...String(out).matchAll(/\btx_[a-f0-9]{32}\b/g)].map(m=>m[0]);
    ensure(new Set(ids).size===1,'UNKNOWN_SUBMISSION_STOPPED_FOR_MANUAL_RECOVERY');
    state.pending.txId=ids[0];await store.save(state);
    log('Reference update submitted; waiting for independent chain confirmation.');return 'submitted';
  }
  return {marketCheck,async tick(){if(busy)return 'busy';busy=true;try{return await inner();}finally{busy=false;}}};
}
