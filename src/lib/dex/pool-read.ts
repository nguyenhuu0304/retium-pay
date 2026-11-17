import { atomic, DEX, type Pool } from "./math";
type Query = (contract: string, method: string, args?: string[]) => Promise<string>;

/** RPC contract calls wrap the contract's own JSON in { ok, data }. */
export function decodeContractData(raw: string): any {
  let value: any = JSON.parse(raw);
  for (let depth = 0; depth < 5; depth++) {
    if (value && typeof value === "object" && value.ok === true && "data" in value) {
      value = typeof value.data === "string" ? JSON.parse(value.data) : value.data;
      continue;
    }
    if (value && typeof value === "object" && typeof value.output === "string") {
      try {
        value = JSON.parse(value.output);
        continue;
      } catch {
        return value.output;
      }
    }
    break;
  }
  return value;
}

function checked(value: unknown, token?: string): Pool {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid pool response.");
  const p = value as Record<string, unknown>;
  const tokenB = typeof p.token_b === "string" ? p.token_b.toLowerCase() : "";
  const expected = token?.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(tokenB) || (expected && tokenB !== expected))
    throw Error("Wrong pool returned.");
  return {
    token_b: tokenB,
    reserve_rtm: atomic(p.reserve_rtm).toString(),
    reserve_token: atomic(p.reserve_token).toString(),
    lp_supply: atomic(p.lp_supply).toString(),
  };
}

function poolRows(value: any): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.pools)) return value.pools;
  if (Array.isArray(value.data)) return value.data;
  if (value.pool && typeof value.pool === "object") return [value.pool];
  return [];
}

function nextCursor(value: any, cursor: number): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value.next ?? value.next_cursor ?? value.cursor;
  if (raw === null || raw === undefined || raw === 0 || raw === "0" || raw === "") return null;
  const next = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(next) || next <= cursor)
    throw Error("Pool pagination did not advance.");
  return next;
}

/**
 * get_pool is the fast path. If the node returns an error, an empty wrapper,
 * or a mismatched response, verify against the authoritative DEX pool list.
 * A failed list read is propagated; it is never interpreted as "no pool".
 */
export async function readPool(query: Query, token: string): Promise<Pool | null> {
  if (!/^[0-9a-f]{64}$/i.test(token)) throw Error("Invalid token contract ID.");
  const normalizedToken = token.toLowerCase();

  try {
    const response = decodeContractData(await query(DEX, "get_pool", [normalizedToken]));
    const candidate =
      response && typeof response === "object" && !Array.isArray(response) && "pool" in response
        ? response.pool
        : response;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate))
      return checked(candidate, normalizedToken);
  } catch {
    // A get_pool miss or malformed node response is not proof that no pool exists.
  }

  let cursor = 0;
  for (let page = 0; page < 100; page++) {
    const data = decodeContractData(
      await query(DEX, "list_pools", cursor === 0 ? [] : [String(cursor)]),
    );
    const rows = poolRows(data);
    if (rows.length > 100) throw Error("Invalid pool list.");
    for (const row of rows) {
      const pool = checked(row);
      if (pool.token_b === normalizedToken) return pool;
    }
    const next = nextCursor(data, cursor);
    if (next === null) return null;
    cursor = next;
  }
  throw Error("Pool lookup limit reached. Pool availability could not be confirmed.");
}
