# Retium Pay network upgrade runbook

This project must treat a Retium testnet restart as a network migration, not as
an ordinary frontend deployment.

## Single source of truth

Network settings are read by `src/lib/network/registry.ts`. Application code
must not hardcode RPC URLs, chain IDs, protocol versions, or contract IDs in
feature modules.

Configure these Vercel environment variables for the target environment:

| Variable | Purpose |
| --- | --- |
| `RETIUM_NETWORK_NAME` | Human-readable network name |
| `RETIUM_RPC_URL` | HTTPS RPC origin, e.g. `https://rpc.retium.org` |
| `RETIUM_CHAIN_ID` | Expected chain ID |
| `RETIUM_PROTOCOL_VERSION` | Expected transaction payload version |
| `RETIUM_DEX_ENABLED` | Set to `true` only after DEX verification |
| `RETIUM_DEX_CONTRACT_ID` | Newly deployed DEX contract ID |
| `RETIUM_DEX_CODE_HASH` | Expected DEX code hash |
| `RETIUM_LENDING_ENABLED` | Set to `true` only after market verification |
| `RETIUM_LENDING_MARKET` | Lending market contract ID |
| `RETIUM_LENDING_CODE_HASH` | Expected lending market code hash |
| `RETIUM_LENDING_ASSET` | Debt asset contract ID |
| `RETIUM_LENDING_ASSET_CODE_HASH` | Expected debt asset code hash |

Do not copy old contract IDs or code hashes into a new testnet environment.
The legacy DEX ID is retained temporarily for migration diagnostics only; it
is not marked verified and cannot enable the DEX feature.

## Upgrade checklist

1. Read the official Retium release notes and record node, chain and payload
   versions.
2. Verify the configured RPC origin and read-only API response shape.
3. Confirm the target chain ID using an authoritative network response.
4. Rebuild or obtain the official contract artifact; record its SHA-256 and
   on-chain code hash.
5. Deploy contracts only with explicit operator approval. Record the resulting
   contract IDs and code hashes.
6. Verify each contract by reading it back from the target RPC and comparing
   its code hash. A configured ID is not proof of deployment.
7. Verify wallet connection, signing method, nonce behavior, transaction
   submission and finality using a dedicated test wallet and low-risk test
   transactions.
8. Enable only the features whose network, wallet and contract checks pass.
9. Run local TypeScript and production builds, then test on a preview deployment.
10. Promote to production only after the preview checklist passes.

## Safety rules

- Never reset or migrate the payment database as part of a chain upgrade.
- Never infer that an old contract exists on a new genesis.
- Never automatically deploy, initialize, approve, sign or transfer assets.
- A failed health check must disable only the affected on-chain feature.
- Payment history and previously verified transaction records remain readable.
- Never expose API keys, wallet seeds, private keys or signing payloads in
  diagnostics.
