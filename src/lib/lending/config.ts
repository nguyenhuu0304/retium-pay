export type LendingConfig = {
  enabled: boolean;
  market: string;
  marketCodeHash: string;
  asset: string;
  assetCodeHash: string;
  symbol: string;
  reason: string;
};
export function lendingConfig(): LendingConfig {
  const market = process.env.RETIUM_LENDING_MARKET || "",
    marketCodeHash = process.env.RETIUM_LENDING_CODE_HASH || "",
    asset = process.env.RETIUM_LENDING_ASSET || "",
    assetCodeHash = process.env.RETIUM_LENDING_ASSET_CODE_HASH || "",
    symbol = process.env.RETIUM_LENDING_SYMBOL || "Debt asset";
  const valid =
    [market, marketCodeHash, asset, assetCodeHash].every((s) =>
      /^[0-9a-f]{64}$/.test(s),
    ) && /^[A-Za-z0-9._ -]{1,20}$/.test(symbol);
  const enabled = valid && process.env.RETIUM_LENDING_ENABLED === "true";
  return {
    enabled,
    market,
    marketCodeHash,
    asset,
    assetCodeHash,
    symbol,
    reason: enabled
      ? ""
      : "Testnet market is not activated. Contract and debt asset verification are required.",
  };
}
