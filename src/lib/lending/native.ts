// Wallet spendable/balance_rtm fields are decimal RTM, never atomic units.
// Missing data stays null; a real zero is a valid balance.
export function nativeBalance(account: Record<string, unknown>): string | null {
  const value = account.spendable ?? account.balance_rtm;
  if (typeof value !== "string" || !/^\d{1,39}(?:\.\d{1,18})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const atomic = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
  return atomic <= (1n << 128n) - 1n ? String(atomic) : null;
}
