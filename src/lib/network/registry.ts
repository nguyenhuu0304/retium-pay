/**
 * Single source of truth for Retium network configuration.
 *
 * Server-side only: read process.env here, then expose only safe diagnostic
 * fields through API routes. Never expose API keys, signing material or secrets.
 */

export type ContractConfig = {
  id: string;
  codeHash: string;
  source: "environment" | "legacy-fallback" | "unset";
  configured: boolean;
  verified: boolean;
};

export type RetiumNetworkConfig = {
  name: string;
  rpcUrl: string;
  chainId: number | null;
  protocolVersion: number | null;
  dex: {
    enabled: boolean;
    contract: ContractConfig;
  };
  lending: {
    enabled: boolean;
    market: ContractConfig;
    asset: ContractConfig;
  };
};

const CONTRACT_ID = /^[0-9a-f]{64}$/;
const ADDRESS_OR_HASH = /^[0-9a-f]{64}$/;

function readInteger(value: string | undefined): number | null {
  if (!value || !/^[0-9]{1,9}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readContract(
  idValue: string | undefined,
  hashValue: string | undefined,
  legacyId = "",
): ContractConfig {
  const fromEnvironment = Boolean(idValue);
  const id = idValue || legacyId;
  const codeHash = hashValue || "";
  const validId = CONTRACT_ID.test(id);
  const validHash = ADDRESS_OR_HASH.test(codeHash);

  return {
    id: validId ? id : "",
    codeHash: validHash ? codeHash : "",
    source: fromEnvironment
      ? "environment"
      : legacyId
        ? "legacy-fallback"
        : "unset",
    configured: validId,
    // Configuration is not proof of on-chain deployment. Diagnostics must
    // compare this expected hash with the live contract before enabling use.
    verified: false,
  };
}

export function getRetiumNetworkConfig(
  env: NodeJS.ProcessEnv = process.env,
): RetiumNetworkConfig {
  let rpcUrl = (env.RETIUM_RPC_URL || "https://rpc.retium.org").trim();
  try {
    const parsed = new URL(rpcUrl);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/"
    ) {
      throw new Error("Invalid RPC URL");
    }
    rpcUrl = parsed.origin;
  } catch {
    rpcUrl = "";
  }

  const market = readContract(
    env.RETIUM_LENDING_MARKET,
    env.RETIUM_LENDING_CODE_HASH,
  );
  const asset = readContract(
    env.RETIUM_LENDING_ASSET,
    env.RETIUM_LENDING_ASSET_CODE_HASH,
  );

  const dex = readContract(
    env.RETIUM_DEX_CONTRACT_ID,
    env.RETIUM_DEX_CODE_HASH,
    // Kept only to preserve old read-only references during migration.
    // It is never considered verified and must not authorize transactions.
    "a8a370858f29a78c07dd115a7ef123d93e1e3ef1caa3bb7c27565c8ffb14945c",
  );

  return {
    name: env.RETIUM_NETWORK_NAME || "Retium Testnet",
    rpcUrl,
    // Retium testnet wire reference currently documents chain ID 3 / payload v6.
    // Environment overrides allow a future network upgrade without code edits.
    chainId: readInteger(env.RETIUM_CHAIN_ID || "3"),
    protocolVersion: readInteger(env.RETIUM_PROTOCOL_VERSION || "6"),
    dex: {
      enabled:
        env.RETIUM_DEX_ENABLED === "true" &&
        dex.source === "environment" &&
        Boolean(dex.codeHash),
      contract: dex,
    },
    lending: {
      enabled:
        env.RETIUM_LENDING_ENABLED === "true" &&
        market.source === "environment" &&
        asset.source === "environment" &&
        Boolean(market.codeHash && asset.codeHash),
      market,
      asset,
    },
  };
}

/** Safe subset suitable for returning from a public diagnostics endpoint. */
export function publicNetworkConfig(config = getRetiumNetworkConfig()) {
  return {
    name: config.name,
    rpcUrl: config.rpcUrl,
    chainId: config.chainId,
    protocolVersion: config.protocolVersion,
    dex: {
      enabled: config.dex.enabled,
      contract: {
        id: config.dex.contract.id,
        codeHashConfigured: Boolean(config.dex.contract.codeHash),
        source: config.dex.contract.source,
        verified: config.dex.contract.verified,
      },
    },
    lending: {
      enabled: config.lending.enabled,
      market: {
        id: config.lending.market.id,
        codeHashConfigured: Boolean(config.lending.market.codeHash),
        source: config.lending.market.source,
        verified: config.lending.market.verified,
      },
      asset: {
        id: config.lending.asset.id,
        codeHashConfigured: Boolean(config.lending.asset.codeHash),
        source: config.lending.asset.source,
        verified: config.lending.asset.verified,
      },
    },
  };
}
