import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { readJson, validateSafehouse } from './source.mjs';
import { createPublisher } from './publisher.mjs';
import { fileStore, acquireLock } from './state.mjs';
const exec=promisify(execFile),live=process.argv.includes('--run'),once=process.argv.includes('--once');
let stopped=false;const abort=new AbortController();
process.on('SIGINT',()=>{stopped=true;abort.abort();});process.on('SIGTERM',()=>{stopped=true;abort.abort();});
let unlock;
try{
  if(!live){validateSafehouse(await readJson('/api/safehouse'));console.log('PASS Safehouse identity and reserve figures. Reference: 1 RTM = 1 RTD. Read-only; no signature or transaction.');}
  else{
    const file=path.resolve(process.env.RETIUM_ORACLE_STATE||'oracle-state.json');
    if(!process.env.RETIUM_ORACLE_KEY_FILE||!process.env.RETIUM_API_KEY)throw Error('DEDICATED_SIGNER_REQUIRED');
    unlock=acquireLock(process.env.RETIUM_ORACLE_LOCK||file+'.lock');
    const store=fileStore(file);
    const cli=async args=>{
      const env={...process.env,RETIUM_KEY:process.env.RETIUM_ORACLE_KEY_FILE,RETIUM_RPC:'https://rpc.retium.org',RETIUM_CHAIN:'devnet',RETIUM_FEE:'RTM'};
      try{return (await exec(process.env.RETIUM_CLI||'retium',args,{env,timeout:45000,maxBuffer:1000000,windowsHide:true})).stdout;}
      catch{throw Error('SIGNER_UNAVAILABLE_CHECK_SAVED_STATE');}
    };
    const publisher=createPublisher({config:{market:process.env.RETIUM_ORACLE_MARKET||'',codeHash:process.env.RETIUM_ORACLE_CODE_HASH||'',oracle:process.env.RETIUM_ORACLE_ADDRESS||''},readJson,cli,store,log:console.log});
    do{
      try{await publisher.tick();}
      catch(e){
        const safe=/^[A-Z_]+$/.test(e.message)?e.message:'SOURCE_UNAVAILABLE';console.error('Oracle check stopped:',safe);
        const state=await store.load();
        if(once||state.halted||(state.pending&&!state.pending.txId)){process.exitCode=1;break;}
      }
      if(once||stopped)break;
      try{await delay(15000,undefined,{signal:abort.signal});}catch{break;}
    }while(!stopped);
  }
}catch(e){console.error('Publisher stopped:',/^[A-Z_]+$/.test(e.message)?e.message:'CONFIGURATION_OR_STORAGE_UNAVAILABLE');process.exitCode=1;}
finally{unlock?.();}
