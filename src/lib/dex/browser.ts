// Public market display only; transaction review and payment validation stay on the server.
import { publicRead } from "../rpc/public-read";
import { DEX, atomic, decimalAtomic, type Pool } from "./math";
let nextReadAt = 0;
async function rpcRead(endpoint: string) {
  // Space request starts to avoid a burst when opening a 12-token page.
  const now = Date.now();
  const delay = Math.max(0, nextReadAt - now);
  nextReadAt = Math.max(now, nextReadAt) + 300;
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  return publicRead(`/${endpoint}`);
}
async function query(contract: string, method: string, args: string[] = []) {
  // The current node treats commas as argument separators before URL decoding.
  // Restrict each value to plain IDs/names/numbers, then preserve literal commas.
  const plain = /^[0-9A-Za-z_]+$/;
  if (
    !/^[0-9a-f]{64}$/.test(contract) ||
    !plain.test(method) ||
    args.some((arg) => !plain.test(arg))
  ) {
    throw Error("Invalid contract query arguments.");
  }
  const data = await rpcRead(
    `contract/${contract}/query?method=${method}&args=${args.join(",")}`,
  );
  if (data.ok !== true)
    throw Error(String(data.error || "Contract query failed.").slice(0, 200));
  if (typeof data.output !== "string")
    throw Error("Unexpected contract query response.");
  return data.output;
}
export async function pools(cursor: string) {
  if (!/^[0-9]{1,12}$/.test(cursor)) throw Error("Invalid cursor.");
  const data = JSON.parse(
    await query(DEX, "list_pools", cursor === "0" ? [] : [cursor]),
  );
  const list = Array.isArray(data) ? data : data.pools;
  if (!Array.isArray(list)) throw Error("Invalid pool list.");
  const next =
    !Array.isArray(data) &&
    Number.isSafeInteger(data.next) &&
    data.next > Number(cursor)
      ? String(data.next)
      : null;
  return {
    pools: list
      .filter((p: Pool) => p && /^[0-9a-f]{64}$/.test(p.token_b))
      .slice(0, 100)
      .map((p: Pool) => ({
        token: p.token_b,
        reserveRtm: atomic(p.reserve_rtm).toString(),
      })),
    next,
  };
}
export async function tokenInfo(token: string) {
  const data = await rpcRead(`contract/${token}`);
  if (data.contract_id !== token) throw Error("Wrong token returned by RPC.");
  const meta = data.rcp_metadata,
    traits: unknown[] = meta?.traits || [],
    caps: unknown[] = meta?.capabilities || [];
  if (
    !traits.includes("fungible") ||
    !["approve", "transfer_from", "balance_of", "allowance"].every((c) =>
      caps.includes(c),
    )
  )
    throw Error("This contract is not a supported fungible token.");
  if (!traits.includes("decimals:18"))
    throw Error(
      "This release supports only tokens explicitly declaring 18 decimals.",
    );
  const symbol =
    traits
      .find(
        (x): x is string => typeof x === "string" && x.startsWith("symbol:"),
      )
      ?.slice(7) || token.slice(0, 10);
  return {
    symbol:
      /^[A-Za-z0-9._-]{1,20}$/.test(symbol) && symbol !== "RTM"
        ? symbol
        : `Token ${token.slice(0, 10)}`,
    codeHash: data.code_hash,
  };
}
export async function market(token: string, wallet: string) {
  const info = await tokenInfo(token);
  let pool: Pool | null = null;
  try {
    const p = JSON.parse(await query(DEX, "get_pool", [token]));
    if (p.token_b !== token) throw Error("Wrong pool returned.");
    atomic(p.reserve_rtm);
    atomic(p.reserve_token);
    atomic(p.lp_supply);
    pool = p;
  } catch (e) {
    if (!(e instanceof Error) || !/Pool not found/i.test(e.message)) throw e;
  }
  const account = await rpcRead(`wallet/${wallet}`);
  const balanceToken = atomic(await query(token, "balance_of", [wallet]));
  const allowance = atomic(await query(token, "allowance", [wallet, DEX]));
  const position = pool
    ? JSON.parse(await query(DEX, "get_lp_balance", [token, wallet]))
    : { lp_balance: "0", locked: "0", until_ms: 0 };
  const lp = atomic(position.lp_balance),
    locked = atomic(position.locked);
  const untilMs = Number(position.until_ms);
  if (
    !Number.isSafeInteger(untilMs) ||
    untilMs < -1 ||
    (locked > 0n && untilMs < 0) ||
    locked > lp
  )
    throw Error("Invalid LP lock state.");
  const nonce = account.nonce ?? account.next_nonce;
  if (!Number.isSafeInteger(nonce) || nonce < 0)
    throw Error("RPC did not return a usable wallet nonce.");
  // spendable and balance_rtm are decimal RTM in the current wallet API.
  const balanceRtm = decimalAtomic(account.spendable ?? account.balance_rtm);
  return {
    info,
    pool,
    balanceToken,
    allowance,
    lp,
    locked,
    untilMs,
    nonce,
    balanceRtm,
  };
}
const pickerCache = new Map<
  string,
  { expires: number; symbol: string; codeHash: string }
>();
export async function tokenPage(cursor: string, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100)
    throw Error("Invalid token page.");
  const page = await pools(cursor);
  const selected = page.pools.slice(offset, offset + 12);
  const tokens: { token: string; symbol: string; supported: boolean }[] = [];
  for (let start = 0; start < selected.length; start += 4) {
    const batch = selected.slice(start, start + 4);
    const results = await Promise.allSettled(
      batch.map(async (item) => {
        let info = pickerCache.get(item.token);
        if (!info || info.expires < Date.now()) {
          const fresh = await tokenInfo(item.token);
          info = { ...fresh, expires: Date.now() + 300_000 };
          if (pickerCache.size >= 500)
            pickerCache.delete(pickerCache.keys().next().value!);
          pickerCache.set(item.token, info);
        }
        return { token: item.token, symbol: info.symbol, supported: true };
      }),
    );
    results.forEach((result, index) =>
      tokens.push(
        result.status === "fulfilled"
          ? result.value
          : {
              token: batch[index].token,
              symbol: "Unavailable",
              supported: false,
            },
      ),
    );
  }
  const nextOffset = offset + selected.length;
  const next =
    nextOffset < page.pools.length
      ? { cursor, offset: nextOffset }
      : page.next
        ? { cursor: page.next, offset: 0 }
        : null;
  return { tokens, next };
}
export async function marketSummary(token: string, wallet: string) {
  if (!/^[0-9a-f]{64}$/.test(token) || !/^rete[0-9a-f]{68}$/.test(wallet))
    throw Error("Select a token and connect a wallet.");
  const m = await market(token, wallet);
  return {
    token,
    wallet,
    symbol: m.info.symbol,
    codeHash: m.info.codeHash,
    pool: m.pool,
    lp: m.lp.toString(),
    locked: m.locked.toString(),
    untilMs: m.untilMs,
    balanceRtm: m.balanceRtm.toString(),
    balanceToken: m.balanceToken.toString(),
    readAt: Date.now(),
  };
}
