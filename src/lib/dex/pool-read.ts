import { atomic, DEX, type Pool } from "./math";
type Query = (contract: string, method: string, args?: string[]) => Promise<string>;
export const WHISK_DEX = "59bf79b965fc9ae4f6854ca766027d0275e76bc56f060a377ec49106baf54f61";

/** RPC contract calls wrap the contract's own JSON in { ok, data }. */
export function decodeContractData(raw: string): any {
  let value: any = JSON.parse(raw);
  for (let depth = 0; depth < 5; depth++) {
    if (value && typeof value === "object" && value.ok === true && "data" in value) {
      value = typeof value.data === "string" ? JSON.parse(value.data) : value.data;
      continue;
    }
    if (value && typeof value === "object" && typeof value.output === "string") {
      try { value = JSON.parse(value.output); continue; }
      catch { return value.output; }
    }
    break;
  }
  return value;
}
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}
function checked(value: unknown, token?: string): Pool {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid pool response.");
  const p = value as Record<string, unknown>;
  const tokenB = typeof p.token_b === "string" ? p.token_b.toLowerCase() : "";
  const expected = token?.toLowerCase();
  if (!validId(tokenB) || (expected && tokenB !== expected)) throw Error("Wrong pool returned.");
  return {
    token_b: tokenB,
    reserve_rtm: atomic(p.reserve_rtm).toString(),
    reserve_token: atomic(p.reserve_token).toString(),
    lp_supply: atomic(p.lp_supply).toString(),
    source: "retium",
    kind: "pool",
    dex: DEX,
  };
}
function whiskPool(value: unknown, token?: string, kind: "pool" | "v2" = "pool"): Pool {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid Whisk pool response.");
  const p = value as Record<string, unknown>;
  const id = typeof p.token_b === "string" ? p.token_b.toLowerCase() : typeof p.token === "string" ? p.token.toLowerCase() : "";
  if (!validId(id) || (token && id !== token.toLowerCase())) throw Error("Wrong Whisk pool returned.");
  return {
    token_b: id,
    reserve_rtm: atomic(p.reserve_rtm).toString(),
    reserve_token: atomic(p.reserve_token).toString(),
    lp_supply: kind === "v2" ? "0" : atomic(p.lp_supply).toString(),
    source: "whisk",
    kind,
    dex: WHISK_DEX,
    ...(kind === "v2" ? { virtual_rtm: atomic(p.virtual_rtm).toString() } : {}),
  };
}
function rows(value: any): unknown[] {
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
  if (!Number.isSafeInteger(next) || next <= cursor) throw Error("Pool pagination did not advance.");
  return next;
}
async function listedPool(query: Query, contract: string, method: string, token: string, kind: "pool" | "v2"): Promise<Pool | null> {
  let cursor = 0;
  for (let page = 0; page < 100; page++) {
    const data = decodeContractData(await query(contract, method, cursor === 0 ? [] : [String(cursor)]));
    const list = rows(data);
    if (list.length > 100) throw Error("Invalid pool list.");
    for (const row of list) {
      const item = whiskPool(row, undefined, kind);
      if (item.token_b === token) return item;
    }
    const next = nextCursor(data, cursor);
    if (next === null) return null;
    cursor = next;
  }
  throw Error("Whisk pool lookup limit reached.");
}
/** Read only the native Retium Pay DEX pool. */
export async function readPool(query: Query, token: string): Promise<Pool | null> {
  if (!validId(token)) throw Error("Invalid token contract ID.");
  const normalizedToken = token.toLowerCase();
  try {
    const response = decodeContractData(await query(DEX, "get_pool", [normalizedToken]));
    const candidate = response && typeof response === "object" && !Array.isArray(response) && "pool" in response ? response.pool : response;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return checked(candidate, normalizedToken);
  } catch { /* Confirm misses against the full pool registry below. */ }
  let cursor = 0;
  for (let page = 0; page < 100; page++) {
    const data = decodeContractData(await query(DEX, "list_pools", cursor === 0 ? [] : [String(cursor)]));
    const list = rows(data);
    if (list.length > 100) throw Error("Invalid pool list.");
    for (const row of list) {
      const pool = checked(row);
      if (pool.token_b === normalizedToken) return pool;
    }
    const next = nextCursor(data, cursor);
    if (next === null) return null;
    cursor = next;
  }
  throw Error("Pool lookup limit reached. Pool availability could not be confirmed.");
}
export async function readWhiskPool(query: Query, token: string): Promise<Pool | null> {
  if (!validId(token)) throw Error("Invalid token contract ID.");
  const id = token.toLowerCase();
  try {
    const value = decodeContractData(await query(WHISK_DEX, "get_pool", [id]));
    const candidate = value && typeof value === "object" && !Array.isArray(value) && "pool" in value ? value.pool : value;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return whiskPool(candidate, id, "pool");
  } catch { /* Check the authoritative paginated registry. */ }
  const ordinary = await listedPool(query, WHISK_DEX, "list_pools", id, "pool");
  if (ordinary) return ordinary;
  try {
    const value = decodeContractData(await query(WHISK_DEX, "get_v2", [id]));
    const candidate = value && typeof value === "object" && !Array.isArray(value) && "pool" in value ? value.pool : value;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return whiskPool(candidate, id, "v2");
  } catch { /* Validate against list_v2 before treating it as absent. */ }
  return listedPool(query, WHISK_DEX, "list_v2", id, "v2");
}
export async function readAnyPool(query: Query, token: string): Promise<Pool | null> {
  const native = await readPool(query, token);
  if (native) return native;
  return readWhiskPool(query, token);
}
export async function whiskPools(query: Query, kind: "pool" | "v2", cursor: string) {
  if (!/^[0-9]{1,12}$/.test(cursor)) throw Error("Invalid cursor.");
  const method = kind === "v2" ? "list_v2" : "list_pools";
  const data = decodeContractData(await query(WHISK_DEX, method, cursor === "0" ? [] : [cursor]));
  const list = rows(data);
  if (!Array.isArray(list) || list.length > 100) throw Error("Invalid Whisk pool list.");
  const pools = list.map((row) => whiskPool(row, undefined, kind));
  const next = nextCursor(data, Number(cursor));
  return { pools, next: next === null ? null : String(next) };
}
