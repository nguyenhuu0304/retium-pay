const UNIT = 10n ** 18n;
export function splitUnits(value: string) {
  if (!/^(0|[1-9]\d{0,17})(\.\d{1,18})?$/.test(value))
    throw Error("Enter a positive RTM amount, up to 18 decimals.");
  const [whole, fraction = ""] = value.split(".");
  const result = BigInt(whole) * UNIT + BigInt(fraction.padEnd(18, "0"));
  if (result <= 0n) throw Error("Each amount must be greater than zero.");
  return result;
}
export function splitFormat(value: bigint) {
  const fraction = (value % UNIT)
    .toString()
    .padStart(18, "0")
    .replace(/0+$/, "");
  return `${value / UNIT}${fraction ? `.${fraction}` : ""}`;
}
export function equalShares(total: string, count: number) {
  if (!Number.isInteger(count) || count < 2 || count > 20)
    throw Error("Enter 2 to 20 payers.");
  const units = splitUnits(total),
    n = BigInt(count);
  if (units < n)
    throw Error("Total is too small to divide between all payers.");
  return Array.from({ length: count }, (_, i) =>
    splitFormat(units / n + (BigInt(i) < units % n ? 1n : 0n)),
  );
}
