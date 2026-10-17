import { atomic, DEX, type Pool } from "./math";
type Query = (contract: string, method: string, args?: string[]) => Promise<string>;
function checked(value: unknown, token?: string): Pool {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid pool response.");
  const p = value as Record<string, unknown>;
  if (typeof p.token_b !== "string" || !/^[0-9a-f]{64}$/.test(p.token_b) || (token && p.token_b !== token)) throw Error("Wrong pool returned.");
  return { token_b: p.token_b, reserve_rtm: atomic(p.reserve_rtm).toString(), reserve_token: atomic(p.reserve_token).toString(), lp_supply: atomic(p.lp_supply).toString() };
}
export async function readPool(query: Query, token: string): Promise<Pool | null> {
  try { return checked(JSON.parse(await query(DEX, "get_pool", [token])), token); }
  catch (error) {
    // A generic HTTP 400 is NOT evidence of absence. Confirm against the complete list.
    if (!(error instanceof Error) || !/\(400\)|Pool not found|negative output length/i.test(error.message)) throw error;
  }
  let cursor = 0;
  for (let page = 0; page < 100; page++) {
    const data = JSON.parse(await query(DEX, "list_pools", cursor === 0 ? [] : [String(cursor)]));
    const rows = Array.isArray(data) ? data : data?.pools;
    if (!Array.isArray(rows) || rows.length > 100) throw Error("Invalid pool list.");
    for (const row of rows) { const pool = checked(row); if (pool.token_b === token) return pool; }
    const next = Array.isArray(data) ? null : data.next;
    if (next === null || next === undefined || next === 0) return null;
    if (!Number.isSafeInteger(next) || next <= cursor) throw Error("Pool pagination did not advance.");
    cursor = next;
  }
  throw Error("Pool lookup limit reached. Pool availability could not be confirmed.");
}
