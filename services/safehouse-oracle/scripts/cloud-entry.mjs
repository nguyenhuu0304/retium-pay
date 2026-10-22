import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const mode=process.env.RETIUM_ORACLE_MODE||'probe';
let privateFile;
try{
  if(!['probe','run'].includes(mode))throw Error('INVALID_MODE');
  if(mode==='run'){
    // State must survive restarts; the lock stays container-local to avoid stale PID locks after redeploy.
    const stateDir='/data';
    if(process.env.RETIUM_ORACLE_PERSISTENCE_ACK!=='volume-mounted-single-replica')throw Error('PERSISTENT_VOLUME_SINGLE_REPLICA_REQUIRED');
    if(!fs.existsSync(stateDir)||!fs.statSync(stateDir).isDirectory())throw Error('MOUNT_DATA_VOLUME_REQUIRED');
    fs.accessSync(stateDir,fs.constants.W_OK);
    const encoded=process.env.RETIUM_ORACLE_KEY_BASE64||'';
    if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)||encoded.length>100000)throw Error('DEDICATED_KEY_SECRET_REQUIRED');
    const bytes=Buffer.from(encoded,'base64');if(!bytes.length||bytes.toString('base64')!==encoded)throw Error('INVALID_KEY_ENCODING');
    const dir=fs.mkdtempSync('/tmp/retium-publisher-');fs.chmodSync(dir,0o700);
    privateFile=path.join(dir,'publisher.sk');fs.writeFileSync(privateFile,bytes,{mode:0o600,flag:'wx'});bytes.fill(0);
    process.env.RETIUM_ORACLE_KEY_FILE=privateFile;
    process.env.RETIUM_ORACLE_STATE='/data/oracle-state.json';
    process.env.RETIUM_ORACLE_LOCK='/tmp/retium-publisher.lock';
    delete process.env.RETIUM_ORACLE_KEY_BASE64;
  }
  const child=spawn(process.execPath,['scripts/oracle-worker.mjs',...(mode==='run'?['--run']:['--once'])],{stdio:'inherit',env:process.env});
  const stop=signal=>{child.kill(signal);};
  process.on('SIGTERM',()=>stop('SIGTERM'));process.on('SIGINT',()=>stop('SIGINT'));
  child.on('error',()=>{console.error('Publisher process unavailable. No automatic resubmission.');process.exitCode=1;});
  child.on('close',code=>{if(privateFile){try{fs.unlinkSync(privateFile);fs.rmdirSync(path.dirname(privateFile));}catch{}}process.exitCode=code??1;});
}catch(e){console.error('Cloud publisher stopped:',/^[A-Z_]+$/.test(e.message)?e.message:'CONFIGURATION_UNAVAILABLE');process.exitCode=1;}
