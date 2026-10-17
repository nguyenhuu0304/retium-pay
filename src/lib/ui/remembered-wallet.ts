export type RememberedWallet = { address: string; chainId: number };
// A remembered selection is UI state only; every payment still requires payer signature.
export function parseRememberedWallet(raw: string | null): RememberedWallet | null {
  try {
    const value = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        typeof value.address !== "string" || !/^rete[0-9a-f]{68}$/.test(value.address) ||
        value.chainId !== 3) return null;
    return { address: value.address, chainId: 3 };
  } catch { return null; }
}
