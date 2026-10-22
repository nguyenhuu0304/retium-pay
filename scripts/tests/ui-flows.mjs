// Execute the actual TSX event handlers with React hooks, RPC and Wallet adapters.
// This is a component interaction test, not a claim of real-browser/popup QA.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'../..');
const U=10n**18n,wallet='rete'+'a'.repeat(68),market='1'.repeat(64),asset='2'.repeat(64);
const compileCache=new Map();
function pure(file){file=path.resolve(root,file);if(compileCache.has(file))return compileCache.get(file);const compiledModule={exports:{}};compileCache.set(file,compiledModule.exports);const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText;const local=s=>s.startsWith('.')?pure(path.resolve(path.dirname(file),s)+(path.extname(s)?'':'.ts')):require(s);vm.runInThisContext('(function(require,compiledModule,exports){'+code+'\n})',{filename:file})(local,compiledModule,compiledModule.exports);compileCache.set(file,compiledModule.exports);return compiledModule.exports;}
const {lendingPlan}=pure('src/lib/lending/plan.ts');
function harness(relative){
 let slots=[],cursor=0,effects=[],dirty=true,tree,timers=new Map(),timerId=0,requested=[],receipts=[],lastPlan=null,lastTicket='',mode='ok',statusMode='confirmed',nonce=7;
 const storage=new Map();const account={address:wallet,chainId:3};
 const config={enabled:true,market,marketCodeHash:'3'.repeat(64),asset,assetCodeHash:'4'.repeat(64),symbol:'RTD',reason:''};
 const snapshot={market:{version:'v0.2.0',oracle_mode:'safehouse_reference_feed',cash:String(100n*U),assets:String(100n*U),supply_shares:String(100n*U),debt_shares:'0',index:String(U),paused:'0',asset_verified:'1',price_fresh:'true',price:String(U),borrow_apr_bps:'500',ltv_bps:'5000',liquidation_bps:'7000',price_ttl_ms:'900000'},position:{account:wallet,supplied:'0',supply_shares:'0',collateral:'0',debt_shares:'0',debt:'0',borrow_limit:'0',health_factor:'none'},nonce,balance:String(10n*U),allowance:'0'};
 const storageAPI={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)};
 const depChanged=(a,b)=>!a||!b||a.length!==b.length||a.some((x,i)=>!Object.is(x,b[i]));
 const hooks={useState(init){const i=cursor++;if(!slots[i])slots[i]={value:typeof init==='function'?init():init};return[slots[i].value,v=>{const next=typeof v==='function'?v(slots[i].value):v;if(!Object.is(next,slots[i].value)){slots[i].value=next;dirty=true;}}];},useRef(init){const i=cursor++;if(!slots[i])slots[i]={current:init};return slots[i];},useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||depChanged(old.deps,deps)){old?.cleanup?.();slots[i]={deps};effects.push(()=>{const cleanup=fn();if(typeof cleanup==='function')slots[i].cleanup=cleanup;});}},useCallback(fn,deps){const i=cursor++,old=slots[i];if(!old||depChanged(old.deps,deps))slots[i]={deps,fn};return slots[i].fn;}};
 const jsx=(type,props)=>({type,props:props||{}});
 const node=name=>Object.assign(p=>jsx(name,p),{displayName:name});
 const ui={UiText:node('UiText'),UiInput:node('UiInput')};
 const provider={request:async request=>{requested.push(request);if(mode==='reject')throw {code:4001,message:'Cancelled'};if(mode==='unknown')return {};const txId='tx_'+String(requested.length).padStart(32,'0');
   if(lastPlan?.approval)snapshot.allowance=lastPlan.call.args[1];
   if(lastPlan?.call.method==='supply'){snapshot.position.supplied=String(BigInt(snapshot.position.supplied)+BigInt(lastPlan.call.args[0]));snapshot.position.supply_shares=snapshot.position.supplied;}
   nonce++;snapshot.nonce=nonce;return {txId,contractId:lastPlan?.call.contractId};}};
 const status=async(ticket,txId,w)=>{if(mode==='status-error')throw Error('RPC unavailable');const plan=JSON.parse(Buffer.from(ticket.split('.')[0],'base64url').toString());return {txId,wallet:w,plan,state:statusMode,notice:'disabled',error:statusMode==='failed'?'Execution failed':''};};
 const fixtureMarket={token:asset,wallet,symbol:'NHT',pool:{token_b:asset,reserve_rtm:String(100n*U),reserve_token:String(100n*U),lp_supply:String(100n*U)},lp:'0',locked:'0',untilMs:0,balanceRtm:String(100n*U),balanceToken:String(100n*U),codeHash:'4'.repeat(64),readAt:Date.now()};
 const mocks={
 'react':hooks,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'Fragment'},'next/link':{__esModule:true,default:node('Link')},
 '../../components/preferences':ui,'../../components/copy-value':{CopyValue:node('CopyValue')},
 '../../components/shared-wallet':{useSharedWallet:()=>({account,ready:true}),WalletRequired:node('WalletRequired')},
 '../../lib/lending/browser':{snapshot:async()=>{if(mode==='read-error')throw Error('Read timed out');return structuredClone(snapshot);},readPublic:async()=>({spendable:'100',balance_rtm:'100',next_nonce:nonce})},
 '../../lib/transactions/public-status':{publicStatus:status,decodePlan:t=>JSON.parse(Buffer.from(t.split('.')[0],'base64url').toString())},
 '../../lib/transactions/history':{saveReceipt:r=>receipts.push(r),syncHistory:async()=>false},
 '../../lib/dex/browser':{tokenPage:async()=>({tokens:[{token:asset,symbol:'NHT',supported:true}],next:null}),marketSummary:async()=>structuredClone(fixtureMarket),reviewSnapshot:async()=>{if(mode==='read-error')throw Error('RPC unavailable');return {}; }},
 '../../lib/dex/deploy-browser':{deploymentAccount:async()=>({nonce,balanceRtm:String(100n*U)})},
 };
 const context={console,Buffer,TextDecoder,Uint8Array,Date,JSON,BigInt,Number,Math,Map,Set,Promise,Error,AbortController,AbortSignal,atob,btoa,localStorage:storageAPI,document:{hidden:false},window:{retium:provider,scrollTo(){},addEventListener(){},removeEventListener(){},confirm:()=>true},queueMicrotask,
 setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),setInterval:()=>++timerId,clearInterval(){},
 fetch:async(url,options)=>{if(String(url)==='/api/lending'&&!options?.body)return {ok:true,json:async()=>config};const b=JSON.parse(options?.body||'{}');if(String(url)==='/api/lending')lastPlan=lendingPlan(config,b);else if(b.operation==='prepare')lastPlan={wallet,token:asset,symbol:'NHT',action:'swap',call:{contractId:'9'.repeat(64),method:'swap',args:['1'],amountAtomic:String(U)},nonce,createdAt:Date.now(),expiresAt:Date.now()+60000,deadline:Date.now()+120000,summary:[],approval:false};else if(b.operation==='prepareDeploy')lastPlan={wallet,token:asset,symbol:'MTT',action:'deploy',call:{contractId:market,method:'deploy',args:[],amountAtomic:'0'},nonce,createdAt:Date.now(),expiresAt:Date.now()+60000,deadline:Date.now()+120000,summary:[],approval:false,deployment:{codeHash:'3'.repeat(64),metadata:{}}};else throw Error('Unexpected network request: '+url);
 lastTicket=Buffer.from(JSON.stringify(lastPlan)).toString('base64url')+'.'+'0'.repeat(64);
 return {ok:true,json:async()=>({plan:lastPlan,ticket:lastTicket,market:fixtureMarket,wasmBase64:'AA=='})};},
 };
 const code=ts.transpileModule(fs.readFileSync(path.join(root,relative),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const compiledModule={exports:{}};const local=s=>mocks[s]??(s.endsWith('.css')?{}:s.startsWith('.')?pure(path.resolve(path.dirname(path.join(root,relative)),s)+'.ts'):require(s));
 vm.runInNewContext('(function(require,compiledModule,exports){'+code+'\n})',context,{filename:relative})(local,compiledModule,compiledModule.exports);
 function render(){dirty=false;cursor=0;tree=compiledModule.exports.default();const work=effects;effects=[];for(const fn of work)fn();}
 async function settle(){for(let i=0;i<35;i++){if(dirty)render();await Promise.resolve();await Promise.resolve();for(const [id,t]of timers){if(t.ms<=200){timers.delete(id);t.fn();}}}if(dirty)render();}
 function all(n,result=[]){if(arguments.length===0)n=tree;if(!n||typeof n!=='object')return result;if(Array.isArray(n)){n.forEach(c=>all(c,result));return result;}result.push(n);all(n.props?.children,result);return result;}
 function text(n){if(n===null||n===undefined||typeof n==='boolean')return '';if(Array.isArray(n))return n.map(text).join('');if(typeof n!=='object')return String(n);return n.props?.text??text(n.props?.children);}
 function button(label){const found=all().find(n=>n.type==='button'&&text(n).replace(' ▾','')===label);assert.ok(found,'Missing button '+label+'; buttons: '+all().filter(n=>n.type==='button').map(text).join(' | '));return found;}
 async function click(label){const b=button(label);assert.ok(!b.props.disabled,'Button disabled '+label);await b.props.onClick();await settle();}
 async function input(id,value){const n=all().find(n=>n.props?.id===id);assert.ok(n,'Missing input '+id);n.props.onChange({target:{value}});await settle();}
 return {settle,click,input,button,all,text,storage,requested,receipts,snapshot,account,get tree(){return tree;},set mode(v){mode=v;},set statusMode(v){statusMode=v;}};
}
const h=harness('src/app/lending/page.tsx');await h.settle();
assert.ok(!h.text(h.tree).includes('Telegram'));
await h.input('lending-amount','0.1');await h.click('Approve RTD');assert.equal(h.requested.length,0);await h.click('Confirm & sign');assert.equal(h.requested.length,1);
await h.click('Check transaction');
await h.click('Supply RTD');assert.equal(h.requested.length,1);await h.click('Confirm & sign');assert.equal(h.requested.length,2);await h.click('Check transaction');assert.equal(h.snapshot.position.supplied,String(U/10n));
console.log('PASS actual Lending handlers: Approve and Supply are separate signatures; read/review does not sign, and confirmed supply releases the form.');
h.mode='read-error';await h.input('lending-amount','0.2');await h.click('Approve RTD');assert.equal(h.button('Approve RTD').props.disabled,false);assert.equal(h.requested.length,2);
h.mode='ok';await h.click('Approve RTD');h.mode='reject';await h.click('Confirm & sign');assert.equal(h.button('Approve RTD').props.disabled,false);assert.ok(!h.storage.has('retium-pay:lending:pending:v1:'+wallet));
console.log('PASS actual Lending handlers: review timeout and wallet rejection restore usable buttons without resubmitting.');
h.mode='ok';await h.click('Approve RTD');h.mode='unknown';await h.click('Confirm & sign');assert.ok(h.storage.has('retium-pay:lending:pending:v1:'+wallet));assert.ok(h.all().some(n=>n.props?.['aria-label']==='Recovery TX ID'));assert.equal(h.all().filter(n=>n.type==='button'&&h.text(n)==='Confirm & sign').length,0);
console.log('PASS unknown Wallet outcome remains recoverable and cannot silently create a duplicate signature.');
// DEX: select a token and fail the review; the primary button must become usable again.
const d=harness('src/app/dex/page.tsx');await d.settle();await d.click('Select token');
const pick=d.all().find(n=>n.type==='button'&&d.text(n).includes('NHT'));assert.ok(pick,'Token picker row');await pick.props.onClick();await d.settle();d.mode='read-error';await d.click('Review swap');assert.equal(d.button('Review swap').props.disabled,false);assert.equal(d.requested.length,0);assert.ok(!d.text(d.tree).includes('Telegram'));
console.log('PASS actual DEX review failure releases its busy lock; no Telegram gate or signature required.');
