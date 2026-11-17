import { atomic, DEX, type Pool } from "./math";

type Query = (contract: string, method: string, args?: string[]) => Promise<string>;
const missing = (error: unknown) =>
  error instanceof Error && /\(400\)|pool not found|negative output length|no pool/i.test(error.message);

function parsePool(value: unknown, token: string, kind: "classic" | "v2"): Pool {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid pool response.");
  const p = value as Record<string, unknown>;
  const returnedToken = kind === "v2" ? p.token : p.token_b;
  if (typeof returnedToken !== "string" || !/^[0-9a-f]{64}$/.test(returnedToken) || returnedToken !== token)
    throw Error("Wrong pool returned.");
  const pool: Pool = {
    token_b: token,
    reserve_rtm: atomic(p.reserve_rtm).toString(),
    reserve_token: atomic(p.reserve_token).toString(),
    lp_supply: kind === "classic" ? atomic(p.lp_supply).toString() : "0",
    kind,
  };
  if (kind === "v2") pool.virtual_rtm = atomic(p.virtual_rtm).toString();
  return pool;
}

async function getOne(query: Query, method: string, token: string, kind: "classic" | "v2") {
  try {
    const raw = await query(DEX, method, [token]);
    const value = JSON.parse(raw);
    if (value === null) return null;
    return parsePool(value, token, kind);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

async function findInList(query: Query, method: string, token: string, kind: "classic" | "v2") {
  let cursor = 0;
  for (let page = 0; page < 100; page++) {
    const raw = await query(DEX, method, cursor === 0 ? [] : [String(cursor)]);
    const data = JSON.parse(raw);
    const rows = Array.isArray(data) ? data : data?.pools;
    if (!Array.isArray(rows) || rows.length > 100) throw Error("Invalid pool list.");
    for (const row of rows) {
      const rowToken = kind === "v2" ? row?.token : row?.token_b;
      if (rowToken === token) return parsePool(row, token, kind);
    }
    const next = Array.isArray(data) ? null : data.next;
    if (next === null || next === undefined || next === 0) return null;
    if (!Number.isSafeInteger(next) || next <= cursor) throw Error("Pool pagination did not advance.");
    cursor = next;
  }
  throw Error("Pool lookup limit reached. Pool availability could not be confirmed.");
}

export async function readPool(query: Query, token: string): Promise<Pool | null> {
  const classic = await getOne(query, "get_pool", token, "classic");
  if (classic) return classic;
  const v2 = await getOne(query, "get_v2", token, "v2");
  if (v2) return v2;
  const listedClassic = await findInList(query, "list_pools", token, "classic");
  if (listedClassic) return listedClassic;
  return findInList(query, "list_v2", token, "v2");
}
