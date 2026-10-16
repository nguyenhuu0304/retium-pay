// Server-only persistence shared by Next.js and the local Telegram/worker runners.
// DATABASE_URL enables PostgreSQL. Vercel never falls back to ephemeral files.
import { mkdir, readFile, writeFile, rename, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
const activeClient = new AsyncLocalStorage();

export const dataNames = Object.freeze([
  'payments.json', 'telegram-links.json', 'telegram-state.json',
  'dex-transactions.json', 'dex-intents.key', 'payments-worker.key',
  'payments-worker-status.json',
]);
const slot = Symbol.for('retium-pay.postgres.v1');
const context = globalThis;
function nameOf(file) {
  const name = path.basename(file);
  if (!dataNames.includes(name)) throw Error('Unknown application data document.');
  return name;
}
export function databaseEnabled() {
  if (process.env.DATABASE_URL?.trim()) return true;
  if (process.env.VERCEL) throw Error('DATABASE_URL is required on Vercel. File storage is disabled.');
  return false;
}
async function database() {
  databaseEnabled();
  if (!context[slot]) {
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 4, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 15_000,
      allowExitOnIdle: true,
    });
    // Never log connection strings or driver errors (which can contain credentials).
    pool.on('error', () => {});
    context[slot] = { pool, ready: null };
  }
  const holder = context[slot];
  if (!holder.ready) {
    holder.ready = (async () => {
      const client = await holder.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '15s'");
      await client.query("SET LOCAL statement_timeout = '20s'");
        await client.query("SELECT pg_advisory_xact_lock(78431209)");
        await client.query(`CREATE TABLE IF NOT EXISTS retium_pay_documents (
          name text PRIMARY KEY,
          content text NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        )`);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    })().catch((error) => { holder.ready = null; throw error; });
  }
  await holder.ready;
  return holder.pool;
}
function decode(name, text) { return name.endsWith('.key') ? {secret:text.trim()} : JSON.parse(text); }
function encode(name, value) { return name.endsWith('.key') ? value.secret : JSON.stringify(value); }
function missing() { return Object.assign(Error('Application document not found.'), {code: 'ENOENT'}); }
/** @param {string} file @param {string} [encoding] @returns {Promise<string>} */
export async function readData(file, encoding = 'utf8') {
  const name = nameOf(file);
  if (!databaseEnabled()) return readFile(file, { encoding: /** @type {'utf8'} */ (encoding) });
  const client = activeClient.getStore() || await database();
  const result = await client.query('SELECT content FROM retium_pay_documents WHERE name = $1', [name]);
  if (!result.rows.length) throw missing();
  return result.rows[0].content;
}
/**
 * One transaction/client for read-modify-write; the per-document advisory lock also
 * covers absent rows. Throwing in the callback rolls back all changes. Callbacks
 * must not mutate the same document recursively or sign/send blockchain transfers.
 * @template T,R
 * @param {string} file
 * @param {()=>T} initial
 * @param {(state:T)=>R|Promise<R>} action
 * @returns {Promise<R>}
 */
export async function withDocument(file, initial, action) {
  const name = nameOf(file);
  if (databaseEnabled()) {
    if (activeClient.getStore()) throw Error('Nested storage mutation is not allowed.');
    const client = await (await database()).connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '15s'");
      await client.query("SET LOCAL statement_timeout = '20s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['retium-pay:' + name]);
      const result = await client.query('SELECT content FROM retium_pay_documents WHERE name=$1', [name]);
      const state = result.rows.length ? decode(name, result.rows[0].content) : initial();
      const output = await activeClient.run(client, () => action(state));
      await client.query(`INSERT INTO retium_pay_documents(name,content) VALUES($1,$2)
        ON CONFLICT(name) DO UPDATE SET content=excluded.content,updated_at=now()`, [name, encode(name, state)]);
      await client.query('COMMIT');
      return output;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  await mkdir(path.dirname(file), {recursive: true});
  const lock = file + '.lock';
  let acquired = false;
  for (let i=0; i<100; i++) {
    try { await mkdir(lock); acquired = true; break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  if (!acquired) throw Error('Application storage busy. Try again.');
  try {
    let state;
    try { state = decode(name, await readFile(file, 'utf8')); }
    catch(error) { if(error.code !== 'ENOENT') throw error; state = initial(); }
    const output = await action(state);
    const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temp, encode(name, state), {mode: 0o600, encoding:'utf8'});
    await rename(temp, file);
    return output;
  } finally { await rmdir(lock); }
}
/** @param {string} file @param {unknown} value */
export async function saveData(file, value) {
  return withDocument(file, () => ({}), async state => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected application document object.');
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, value);
  });
}
/** @param {string} file @returns {Promise<string>} */
export async function stableSecret(file) {
  const row = await withDocument(file, () => ({secret: randomBytes(32).toString('hex')}), value => value);
  if (!/^[0-9a-f]{64}$/.test(row.secret)) throw Error('Invalid application signing key.');
  return row.secret;
}
export async function closeStorage() {
  const holder = context[slot];
  if(holder) { delete context[slot]; await holder.pool.end(); }
}
export async function checkStorage() {
  if(!databaseEnabled()) throw Error('Set DATABASE_URL before deployment.');
  await database();
  return {ok:true, storage:'postgresql'};
}
/** Atomic, insert-only import. Never merges or overwrites a live database.
 * @param {Array<{name:string,content:string}>} entries
 */
export async function importDocuments(entries) {
  if(!databaseEnabled()) throw Error('DATABASE_URL is required.');
  const rows = entries.map(row => ({name:nameOf(row.name),content:row.content})).sort((a,b)=>a.name.localeCompare(b.name));
  if(new Set(rows.map(row=>row.name)).size !== rows.length) throw Error('Duplicate import document.');
  for(const row of rows) {
    const value=decode(row.name,row.content);
    if(row.name.endsWith('.key')) { if(!/^[0-9a-f]{64}$/.test(value.secret)) throw Error('Invalid source key file.'); }
    else if(!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid source document.');
  }
  const client=await (await database()).connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '15s'");
    for(const row of rows) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',['retium-pay:'+row.name]);
    // Existing equal rows make retry safe; any difference aborts the entire import.
    for(const row of rows) {
      const result=await client.query('SELECT content FROM retium_pay_documents WHERE name=$1',[row.name]);
      if(result.rows.length) {
        if(JSON.stringify(decode(row.name,result.rows[0].content)) !== JSON.stringify(decode(row.name,row.content))) throw Error('Database already contains different data. Import cancelled; nothing overwritten.');
      } else await client.query('INSERT INTO retium_pay_documents(name,content) VALUES($1,$2)',[row.name,row.content]);
    }
    await client.query('COMMIT');
    return rows.map(row=>row.name);
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>{}); throw error;
  } finally { client.release(); }
}
