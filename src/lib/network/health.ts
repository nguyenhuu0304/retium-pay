import { getRetiumNetworkConfig } from "./registry";

type JsonRecord = Record<string, unknown>;

export type NodeHealth = {
  reachable: boolean;
  status: string | null;
  version: string | null;
  tick: number | null;
  peers: number | null;
  chainId: number | null;
  protocolVersion: number | null;
  chainIdVerified: boolean;
  protocolVersionVerified: boolean;
  error?: string;
};

export type ContractHealth = {
  configured: boolean;
  deployed: boolean;
  codeHash: string | null;
  hashMatched: boolean | null;
  ready: boolean;
  error?: string;
};

async function readJson(url: string): Promise<{ status: number; value: JsonRecord }> {
  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const raw = await response.text();
  if (raw.length > 1_500_000) throw new Error("RPC response exceeded size limit.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("RPC returned invalid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("RPC returned an unexpected response.");
  }
  return { status: response.status, value: value as JsonRecord };
}

function readNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export async function checkNodeHealth(): Promise<NodeHealth> {
  const config = getRetiumNetworkConfig();
  if (!config.rpcUrl) {
    return {
      reachable: false, status: null, version: null, tick: null, peers: null,
      chainId: null, protocolVersion: null, chainIdVerified: false,
      protocolVersionVerified: false, error: "RETIUM_RPC_URL is invalid.",
    };
  }
  try {
    const { status, value } = await readJson(config.rpcUrl + "/health");
    const chainId = readNumber(value.chain_id ?? value.chainId);
    const protocolVersion = readNumber(
      value.payload_version ?? value.protocol_version ?? value.protocolVersion,
    );
    const reachable = status === 200 && typeof value.status === "string";
    return {
      reachable,
      status: typeof value.status === "string" ? value.status : null,
      version: typeof value.version === "string" ? value.version : null,
      tick: readNumber(value.tick),
      peers: readNumber(value.peers),
      chainId,
      protocolVersion,
      chainIdVerified: config.chainId !== null && chainId === config.chainId,
      protocolVersionVerified:
        config.protocolVersion !== null && protocolVersion === config.protocolVersion,
      ...(!reachable ? { error: "Node health endpoint returned an unexpected response." } : {}),
    };
  } catch (error) {
    return {
      reachable: false, status: null, version: null, tick: null, peers: null,
      chainId: null, protocolVersion: null, chainIdVerified: false,
      protocolVersionVerified: false,
      error: error instanceof Error ? error.message : "Node health check failed.",
    };
  }
}

export async function checkContractHealth(
  id: string,
  expectedCodeHash: string,
  enabled: boolean,
): Promise<ContractHealth> {
  if (!/^[0-9a-f]{64}$/.test(id)) {
    return { configured: false, deployed: false, codeHash: null, hashMatched: null, ready: false, error: "Contract ID is not configured." };
  }
  if (!/^[0-9a-f]{64}$/.test(expectedCodeHash)) {
    return { configured: true, deployed: false, codeHash: null, hashMatched: null, ready: false, error: "Expected code hash is not configured." };
  }
  const config = getRetiumNetworkConfig();
  if (!config.rpcUrl) {
    return { configured: true, deployed: false, codeHash: null, hashMatched: null, ready: false, error: "RPC URL is invalid." };
  }
  try {
    const { status, value } = await readJson(
      config.rpcUrl + "/api/contract/" + id,
    );
    if (status !== 200 || value.contract_id !== id) {
      return { configured: true, deployed: false, codeHash: null, hashMatched: false, ready: false, error: status === 404 ? "Contract does not exist on the active network." : "Contract read failed." };
    }
    const codeHash = typeof value.code_hash === "string" ? value.code_hash : null;
    const hashMatched = Boolean(codeHash && codeHash === expectedCodeHash);
    return {
      configured: true,
      deployed: true,
      codeHash,
      hashMatched,
      ready: enabled && hashMatched,
      ...(!hashMatched ? { error: "Live contract code hash does not match the configured hash." } : !enabled ? { error: "Contract verified, but its feature flag is disabled." } : {}),
    };
  } catch (error) {
    return { configured: true, deployed: false, codeHash: null, hashMatched: null, ready: false, error: error instanceof Error ? error.message : "Contract verification failed." };
  }
}

export async function assertFeatureReady(feature: "dex" | "lending"): Promise<void> {
  const config = getRetiumNetworkConfig();
  const node = await checkNodeHealth();
  if (!node.reachable) throw new Error("Retium node health check failed. On-chain actions are temporarily disabled.");
  if (feature === "dex") {
    if (!config.dex.enabled || config.dex.contract.source !== "environment") {
      throw new Error("DEX is disabled until a new contract ID, expected code hash and RETIUM_DEX_ENABLED=true are configured.");
    }
    const contract = await checkContractHealth(
      config.dex.contract.id,
      config.dex.contract.codeHash,
      config.dex.enabled,
    );
    if (!contract.ready) throw new Error(contract.error || "DEX contract verification failed.");
    return;
  }
  if (!config.lending.enabled) {
    throw new Error("Lending is disabled until its market and asset IDs, expected code hashes and RETIUM_LENDING_ENABLED=true are configured.");
  }
  const [market, asset] = await Promise.all([
    checkContractHealth(config.lending.market.id, config.lending.market.codeHash, true),
    checkContractHealth(config.lending.asset.id, config.lending.asset.codeHash, true),
  ]);
  if (!market.ready) throw new Error("Lending market: " + (market.error || "verification failed."));
  if (!asset.ready) throw new Error("Lending asset: " + (asset.error || "verification failed."));
}
