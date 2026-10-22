import './typescript.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
const cwd=process.cwd(),dir=await mkdtemp(path.join(os.tmpdir(),'retiumpay-isolated-test-'));
const previous=process.env.DATABASE_URL;delete process.env.DATABASE_URL;
process.chdir(dir);
let oldFetch=globalThis.fetch;
try{
 const server=await import('../../src/lib/dex/server.ts'),route=await import('../../src/app/api/dex/route.ts');
 const wallet='rete'+'a'.repeat(68),market='1'.repeat(64),txId='tx_'+'b'.repeat(32),now=Date.now(),token='c'.repeat(64);
 const plan={wallet,token:'2'.repeat(64),symbol:'RTD',action:'swap',call:{contractId:market,method:'swap',args:['1'],amountAtomic:'0'},nonce:12,createdAt:now,expiresAt:now+60000,deadline:now+120000,summary:[],approval:false};
 const ticket=await server.issueTrackingTicket(plan);
 const request=(cookie='')=>new Request('http://localhost:3000/api/dex',{method:'POST',headers:{origin:'http://localhost:3000','Content-Type':'application/json',cookie},body:JSON.stringify({operation:'register',ticket,txId})});
 assert.equal((await route.POST(request())).status,400);
 await mkdir(path.join(dir,'data'),{recursive:true});
 await writeFile(path.join(dir,'data/payments.json'),JSON.stringify({listSessions:{[createHash('sha256').update(token).digest('hex')]:{address:wallet,expiresAt:now+60000}}}));
 const registered=await route.POST(request('retium_requests_session='+token));assert.equal(registered.status,200);
 const body=await registered.json();assert.equal(body.job.notice,'disabled');
 assert.equal((await route.POST(new Request('http://localhost:3000/api/dex',{method:'POST',headers:{origin:'https://evil.example','Content-Type':'application/json'},body:'{}'}))).status,403);
 let telegram=0,reads=0;
 globalThis.fetch=async url=>{if(String(url).includes('telegram.org')){telegram++;throw Error('Unexpected Telegram send');}reads++;return Response.json({tx_id:txId,sender:wallet,recipient:market,action:'call',call:{contract:market,method:'swap',args:['1']},amount:'0',nonce:12,finality:'HardFinal',exec_status:'ok',timestamp:Math.floor(now/1000)});};
 await server.dexTick();await server.dexTick();assert.ok(reads>0);assert.equal(telegram,0);
 assert.equal((await server.job(txId,wallet)).state,'confirmed');
 assert.equal((await server.job(txId,wallet)).notice,'disabled');
 console.log('PASS private History authorization and origin checks retained; DEX verification runs and sends zero Telegram messages.');
}catch(e){throw e;}finally{globalThis.fetch=oldFetch;process.chdir(cwd);if(previous!==undefined)process.env.DATABASE_URL=previous;await rm(dir,{recursive:true,force:true});}
