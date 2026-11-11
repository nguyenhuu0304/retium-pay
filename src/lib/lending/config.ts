import { getRetiumNetworkConfig } from "../network/registry";

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
  const network = getRetiumNetworkConfig();
  const market = network.lending.market;
  const asset = network.lending.asset;
  const symbol = process.env.RETIUM_LENDING_SYMBOL || "Debt asset";
  const validSymbol = /^[A-Za-z0-9._ -]{1,20}$/.test(symbol);
  const enabled = network.lending.enabled && validSymbol;

  return {
    enabled,
    market: market.id,
    marketCodeHash: market.codeHash,
    asset: asset.id,
    assetCodeHash: asset.codeHash,
    symbol: validSymbol ? symbol : "Debt asset",
    reason: enabled
      ? ""
      : "Testnet market is not activated. Configure its contract IDs and expected code hashes, verify them on the active network, then set RETIUM_LENDING_ENABLED=true.",
  };
}
