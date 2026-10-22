import {spawnSync} from 'node:child_process';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../..');
const tests=['contracts/lending-safehouse/tests/runtime.mjs','contracts/lending-safehouse/tests/math.mjs','contracts/lending-safehouse/tests/lifecycle.mjs','services/safehouse-oracle/tests/publisher.mjs','scripts/tests/transaction-status.mjs','scripts/tests/server-policy.mjs','scripts/tests/ui-flows.mjs'];
for(const test of tests){console.log('\nTEST '+test);const r=spawnSync(process.execPath,[test],{cwd:root,stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);}
console.log('PASS all automated checks. Wallet, RPC, token and host adapters are simulated; no live transaction sent.');
