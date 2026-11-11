import {
  getRetiumNetworkConfig,
  publicNetworkConfig,
} from "../../../../lib/network/registry";
import {
  checkContractHealth,
  checkNodeHealth,
} from "../../../../lib/network/health";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const config = getRetiumNetworkConfig();
  const node = await checkNodeHealth();
  const [dex, lendingMarket, lendingAsset] = await Promise.all([
    checkContractHealth(
      config.dex.contract.id,
      config.dex.contract.codeHash,
      config.dex.enabled,
    ),
    checkContractHealth(
      config.lending.market.id,
      config.lending.market.codeHash,
      config.lending.enabled,
    ),
    checkContractHealth(
      config.lending.asset.id,
      config.lending.asset.codeHash,
      config.lending.enabled,
    ),
  ]);

  const identityMatches =
    (node.chainId === null || node.chainIdVerified) &&
    (node.protocolVersion === null || node.protocolVersionVerified);
  const dexReady = node.reachable && identityMatches && dex.ready;
  const lendingReady =
    node.reachable && identityMatches && lendingMarket.ready && lendingAsset.ready;

  const diagnostics = {
    ok: node.reachable,
    checkedAt: new Date().toISOString(),
    network: publicNetworkConfig(config),
    node: {
      reachable: node.reachable,
      status: node.status,
      version: node.version,
      tick: node.tick,
      peers: node.peers,
      error: node.error || null,
    },
    networkIdentity: {
      expectedChainId: config.chainId,
      observedChainId: node.chainId,
      chainIdVerified: node.chainIdVerified,
      expectedProtocolVersion: config.protocolVersion,
      observedProtocolVersion: node.protocolVersion,
      protocolVersionVerified: node.protocolVersionVerified,
      note: "The documented public GET /health response currently exposes status, tick, peers and node version, but not chain ID or payload version. Missing fields are reported as unverified, never assumed to match.",
    },
    contracts: {
      dex,
      lendingMarket,
      lendingAsset,
    },
    features: {
      payments: {
        ready: null,
        mode: "off-chain payment services and history",
        note: "Payment history is independent of DEX/Lending contract health.",
      },
      dex: {
        configured: config.dex.enabled,
        ready: dexReady,
        reason: dexReady ? null : dex.error || node.error || "Network or DEX contract verification did not pass.",
      },
      lending: {
        configured: config.lending.enabled,
        ready: lendingReady,
        reason: lendingReady ? null : lendingMarket.error || lendingAsset.error || node.error || "Network or Lending contract verification did not pass.",
      },
    },
    wallet: {
      adapter: "centralized",
      sdkConfigured: true,
      methods: [
        "retium_requestAccounts",
        "retium_signAuth",
        "retium_sendTransfer",
        "retium_call",
        "retium_deploy",
      ],
      note: "Wallet presence and the connected account chain ID are checked in the browser at connection time; this server endpoint does not claim to inspect a user's wallet.",
    },
    safety: [
      "Read-only checks only; no wallet signature, transaction, deployment, or feature-flag change is performed.",
      "A DEX or Lending failure does not change payment history or payment services.",
      "Configured contract IDs are not treated as verified until live code hashes match.",
    ],
  };

  return Response.json(diagnostics, {
    status: node.reachable ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
