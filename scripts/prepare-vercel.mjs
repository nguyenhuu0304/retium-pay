import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataNames, checkStorage, closeStorage, importDocuments, stableSecret } from '../src/lib/storage/store.mjs';
const project=fileURLToPath(new URL('..', import.meta.url));
const importing=process.argv.includes('--import');
try {
  if(!process.env.DATABASE_URL?.trim()) throw Error('Set DATABASE_URL in .env.local first. Do not send it in chat.');
  await checkStorage();
  if(importing) {
    const rows=[];
    for(const name of dataNames) {
      try { rows.push({name,content:await readFile(path.join(project,'data',name),'utf8')}); }
      catch(error) { if(error.code !== 'ENOENT') throw error; }
    }
    if(!rows.length) throw Error('No existing local data found. Run from the original app with its data folder.');
    const names=await importDocuments(rows);
    console.log(`Imported/verified ${names.length} documents. Local files unchanged. No Telegram message or transfer sent.`);
  } else {
    const url=new URL(process.env.APP_URL || 'http://localhost:3000');
    if(url.protocol!=='https:' || /^(localhost|127\.|\[::1\])/.test(url.hostname) || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw Error('Set APP_URL to the exact public HTTPS production origin (no path/query).');
    if(!process.env.TELEGRAM_BOT_TOKEN?.trim()) throw Error('Set TELEGRAM_BOT_TOKEN before deployment.');
    // Import legacy data BEFORE this check when upgrading an existing installation.
    await stableSecret(path.join(project,'data','dex-intents.key'));
    await stableSecret(path.join(project,'data','payments-worker.key'));
    console.log('PASS: PostgreSQL accessible; public APP_URL configured; signing/worker keys persistent.');
    console.log('Telegram token syntax, Vercel account access and wallet popups must also be verified on the deployed site.');
  }
} catch(error) {
  // Database driver messages can contain secrets: expose only known setup errors.
  const safe=/^(Set |No existing |Database already |Invalid source |Duplicate import)/.test(error.message);
  console.error(safe ? error.message : 'Database preparation failed. Check DATABASE_URL, network access and database permissions. Credentials were not printed.');
  process.exitCode=1;
} finally { await closeStorage(); }
