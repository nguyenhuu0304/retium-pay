// Isolated storage adapter regression tests: no network, credentials or real DB.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash = value => createHash('md5').update(value).digest('hex');
const rows = new Map([['payments.json', '{"payments":{}}']]);
let snapshot, writes = 0, fullReads = 0;
const client = {
  release() {},
  async query(sql, args = []) {
    if (sql === 'BEGIN') snapshot = new Map(rows);
    if (sql === 'ROLLBACK') { rows.clear(); for (const row of snapshot) rows.set(...row); }
    if (sql.includes('SELECT md5(content)')) {
      const content = rows.get(args[0]);
      if (content === undefined) return {rows: []};
      const version = hash(content);
      if (version !== args[1]) fullReads++;
      return {rows: [{version, content: version === args[1] ? null : content}]};
    }
    if (sql.includes('INSERT INTO retium_pay_documents')) { writes++; rows.set(args[0], args[1]); }
    return {rows: []};
  },
};
const pool = {...client, on() {}, async connect() {return client;}, async end() {}};
globalThis.__retiumTestPg = {Pool: class {constructor() {return pool;}}};
const previousUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = 'postgresql://mock-only';
try {
  const source = (await readFile(new URL('../../src/lib/storage/store.mjs', import.meta.url), 'utf8'))
    .replace("import pg from 'pg';", 'const pg = globalThis.__retiumTestPg;');
  const store = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const file = '/mock/payments.json';
  await store.readData(file);
  await store.readData(file);
  assert.equal(fullReads, 1, 'unchanged payload is not retransmitted');
  rows.set('payments.json', '{"payments":{"external":true}}');
  assert.match(await store.readData(file), /external/, 'external updates are visible immediately');
  await store.withDocument(file, () => ({}), () => {});
  assert.equal(writes, 0, 'no-op mutations do not write');
  await store.withDocument(file, () => ({}), state => {state.changed = true;});
  assert.equal(writes, 1);
  assert.match(await store.readData(file), /changed/);
  await assert.rejects(store.withDocument(file, () => ({}), state => {state.bad = true; throw Error('rollback');}));
  assert.doesNotMatch(await store.readData(file), /bad/, 'failed mutations do not leak into cache');
  const key = await store.stableSecret('/mock/dex-intents.key');
  assert.equal(await store.stableSecret('/mock/dex-intents.key'), key);
  assert.equal(writes, 2, 'existing signing secret is not rewritten');
  rows.delete('payments.json');
  await assert.rejects(store.readData(file), {code: 'ENOENT'});
  await store.withDocument(file, () => ({new: true}), () => {});
  assert.equal(JSON.parse(await store.readData(file)).new, true);
  await store.closeStorage();
  console.log('PASS payload reuse, fresh external updates, no-op writes, rollback, stable secrets, deletion and recreation.');
} finally {
  delete globalThis.__retiumTestPg;
  if (previousUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousUrl;
}
