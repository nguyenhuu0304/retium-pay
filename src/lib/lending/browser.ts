import { nativeBalance } from "./native";
import type { LendingConfig } from "./config";
export type Fields = Record<string, string>;
const address = /^rete[0-9a-f]{68}$/;
export async function readPublic(path: string) {
  const r = await fetch(`https://rpc.retium.org/api/${path}`, {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(12000),
    headers: { Accept: "application/json" },
  });
  if (!r.ok)
    throw Error(`Retium API returned HTTP ${r.status}. Please retry the read.`);
  const text = await r.text();
  if (text.length > 100000) throw Error("Response too large.");
  const value = JSON.parse(text);
  if (!value || typeof value !== "object") throw Error("Invalid API response.");
  return value;
}
async function query(c: string, method: string, args: string[] = []) {
  if (
    !/^[0-9a-f]{64}$/.test(c) ||
    !["market", "position", "balance_of", "allowance"].includes(method) ||
    args.some((a) => !address.test(a) && !/^[0-9a-f]{64}$/.test(a))
  )
    throw Error("Invalid read.");
  const r = await readPublic(
    `contract/${c}/query?method=${method}&args=${args.join(",")}`,
  );
  if (
    r.ok !== true ||
    r.contract_id !== c ||
    r.method !== method ||
    typeof r.output !== "string"
  )
    throw Error("Contract query failed.");
  return r.output;
}
function fields(raw: string): Fields {
  const p = JSON.parse(raw);
  if (
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    Object.values(p).some((x) => typeof x !== "string")
  )
    throw Error("Unsupported lending response.");
  return p;
}
export async function snapshot(c: LendingConfig, wallet: string) {
  if (!c.enabled || !address.test(wallet))
    throw Error("Select a testnet wallet and activate the market.");
  const [contract, asset, rawMarket, rawPosition, account, balance, allowance] =
    await Promise.all([
      readPublic(`contract/${c.market}`),
      readPublic(`contract/${c.asset}`),
      query(c.market, "market"),
      query(c.market, "position", [wallet]),
      readPublic(`wallet/${wallet}`),
      query(c.asset, "balance_of", [wallet]),
      query(c.asset, "allowance", [wallet, c.market]),
    ]);
  if (
    contract.code_hash !== c.marketCodeHash ||
    asset.code_hash !== c.assetCodeHash
  )
    throw Error("Contract code hash mismatch. Lending is blocked.");
  const traits: unknown[] = asset.rcp_metadata?.traits || [];
  const capabilities: unknown[] = asset.rcp_metadata?.capabilities || [];
  if (
    !traits.includes("decimals:18") ||
    !["approve", "transfer", "transfer_from", "balance_of", "allowance"].every(
      (method) => capabilities.includes(method),
    )
  )
    throw Error(
      "Debt asset must declare 18 decimals and the required token methods.",
    );
  const market = fields(rawMarket),
    position = fields(rawPosition);
  if (
    !((market.version === "v0.1.0" && market.oracle_mode === "admin_test_feed") || (market.version === "v0.2.0" && market.oracle_mode === "safehouse_reference_feed")) ||
    market.asset !== c.asset ||
    market.asset_hash !== c.assetCodeHash ||
    market.testnet_only !== "true" ||
    position.account !== wallet
  )
    throw Error("Unexpected market or position.");
  const nonce = account.nonce ?? account.next_nonce;
  if (!Number.isSafeInteger(nonce) || nonce < 0)
    throw Error("Wallet nonce unavailable.");
  const clean = (v: string) => {
    const s = v.replace(/^"|"$/g, "").trim();
    if (!/^[0-9]{1,39}$/.test(s)) throw Error("Invalid token balance.");
    return s;
  };
  for (const key of [
    "cash",
    "debt",
    "assets",
    "supply_shares",
    "index",
    "price",
    "min_loan",
  ])
    clean(market[key]);
  for (const key of [
    "collateral",
    "debt",
    "debt_shares",
    "supply_shares",
    "supplied",
    "borrow_limit",
  ])
    clean(position[key]);
  if (position.health_factor !== "none") clean(position.health_factor);
  return {
    market,
    position,
    nonce,
    balance: clean(balance),
    rtmBalance: nativeBalance(account),
    allowance: clean(allowance),
    readAt: Date.now(),
  };
}
export type Snapshot = Awaited<ReturnType<typeof snapshot>>;
