import { publicRead } from "../rpc/public-read";
// Only input for a deployment preview, never proof of payment or execution.
export async function deploymentAccount(wallet: string) {
  if (!/^rete[0-9a-f]{68}$/.test(wallet)) throw Error("Connect a Retium wallet.");
  const data = await publicRead(`/wallet/${wallet}`);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw Error("Invalid wallet response.");
  if (data.address !== undefined && data.address !== wallet) throw Error("Wallet response mismatch.");
  return { wallet, nonce: data.nonce ?? data.next_nonce,
    spendable: data.spendable ?? data.balance_rtm, readAt: Date.now() };
}
