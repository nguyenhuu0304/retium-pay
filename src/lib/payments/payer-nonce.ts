// This is a proposed nonce for a signed intent, never proof that payment happened.
export function payerNonce(value: unknown, payer: string, now = Date.now()): number {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Read the payer wallet again before signing.");
  const data = value as Record<string, unknown>;
  if (data.address !== payer || !/^rete[0-9a-f]{68}$/.test(payer) ||
      typeof data.nonce !== "number" || !Number.isSafeInteger(data.nonce) || data.nonce < 0 ||
      typeof data.readAt !== "number" || !Number.isSafeInteger(data.readAt) ||
      data.readAt > now + 5000 || now - data.readAt > 30000)
    throw Error("Payer wallet data is invalid or expired. Read it again before signing.");
  return data.nonce;
}
