import { publicRead } from "../rpc/public-read";
import { payerNonce } from "./payer-nonce";

export async function readPayerNonce(address: string) {
  if (!/^rete[0-9a-f]{68}$/.test(address)) throw Error("Invalid payer wallet.");
  const value: unknown = await publicRead(`/wallet/${address}`);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("The RPC did not return valid payer wallet data.");
  const data = value as Record<string, unknown>;
  if (data.address !== undefined && data.address !== address)
    throw Error("The RPC returned a different wallet.");
  const snapshot = { address, nonce: data.nonce, readAt: Date.now() };
  payerNonce(snapshot, address);
  return snapshot;
}
