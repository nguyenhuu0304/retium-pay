import {
  getRetiumNetworkConfig,
  publicNetworkConfig,
} from "../../../lib/network/registry";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Probe = {
  reachable: boolean;
  httpStatus?: number;
  codeHash?: string;
  expectedCodeHashMatch?: boolean | null;
  error?: string;
};

async function readJson(url: string): Promise<{ status: number; value: any }> {
  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",
    redirect: "error",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const raw = await response.text();
  if (raw.length > 1_500_000) throw new Error("RPC response exceeded size limit.");
  let value: any = null;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error("RPC returned a non-JSON response.");
  }
  return { status: response.status, value };
}

async function probeContract(
  rpcUrl: string,
  id: string,
  expectedHash: string,
): Promise<Probe> {
  if (!id) return { reachable: false, error: "Contract ID is not configured." };
  try {
    const { status, value } = await readJson(
      `${rpcUrl}/api/contract/${id}`,
    );
    if (status !== 200) {
      return {
        reachable: false,
        httpStatus: status,
        error: status === 404 ? "Contract is absent on this network." : "RPC contract read failed.",
      };
    }
    const codeHash =
      typeof value?.code_hash === "string" ? value.code_hash : undefined;
    return {
      reachable: Boolean(value?.contract_id === id),
      httpStatus: status,
      codeHash,
      expectedCodeHashMatch: expectedHash
        ? codeHash === expectedHash
        : null,
      ...(!codeHash ? { error: "RPC response did not include a code hash." } : {}),
    };
  } catch (error) {
    return {
      reachable: false,
      error: error instanceof Error ? error.message : "Contract probe failed.",
    };
  }
}

export async function GET() {
  const config = getRetiumNetworkConfig();
  if (!config.rpcUrl) {
    return Response.json(
      {
        ok: false,
        checkedAt: new Date().toISOString(),
        configurationError: "RETIUM_RPC_URL must be a valid HTTPS origin.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  let rpc: Probe;
  try {
    // A known transaction is used only to test API reachability and response
    // shape. Its absence is not interpreted as a network failure.
    const sample = "tx_fc4507f0564e6498f7a3378721516581";
    const { status, value } = await readJson(
      `${config.rpcUrl}/api/transaction/${sample}`,
    );
    rpc = {
      reachable: status === 200 || status === 404,
      httpStatus: status,
      ...(status === 200
        ? { error: value?.tx_id === sample ? undefined : "Unexpected transaction response shape." }
        : { error: "RPC is reachable, but the diagnostic sample transaction is not present." }),
    };
  } catch (error) {
    rpc = {
      reachable: false,
      error: error instanceof Error ? error.message : "RPC probe failed.",
    };
  }

  const [dex, lendingMarket, lendingAsset] = await Promise.all([
    probeContract(
      config.rpcUrl,
      config.dex.contract.id,
      config.dex.contract.codeHash,
    ),
    probeContract(
      config.rpcUrl,
      config.lending.market.id,
      config.lending.market.codeHash,
    ),
    probeContract(
      config.rpcUrl,
      config.lending.asset.id,
      config.lending.asset.codeHash,
    ),
  ]);

  const diagnostics = {
    ok: rpc.reachable,
    checkedAt: new Date().toISOString(),
    network: publicNetworkConfig(config),
    checks: {
      rpc,
      contracts: {
        dex,
        lendingMarket,
        lendingAsset,
      },
    },
    notes: [
      "Chain ID and protocol version are configured expectations; this endpoint does not claim to have verified them against the node.",
      "A configured contract ID is not considered deployed or verified until its live code hash matches.",
      "This endpoint is read-only and never submits transactions or changes feature flags.",
    ],
  };

  return Response.json(diagnostics, {
    status: rpc.reachable ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
