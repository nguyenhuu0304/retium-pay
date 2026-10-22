// Display helpers never modify transaction amounts or shares.
export function displayAmount(value: string, places = 4) {
  if (!/^\d+(\.\d+)?$/.test(value)) return value;
  const [whole, fraction = ""] = value.split(".");
  const shortened = fraction.slice(0, places).replace(/0+$/, "");
  if (BigInt(whole) === 0n && !shortened && /[1-9]/.test(fraction)) return "<0." + "0".repeat(places - 1) + "1";
  return whole + (shortened ? "." + shortened : "");
}
export function healthDisplay(health: string, debt: string, fresh: boolean) {
  if (BigInt(debt) === 0n) return { label: "No debt", tone: "neutral", value: "—", percent: 100 };
  if (health === "none") return { label: "Unavailable", tone: "neutral", value: "—", percent: 0 };
  const raw = BigInt(health), unit = 10n ** 18n;
  const percent = Number((raw > 3n * unit ? 3n * unit : raw) * 10000n / (3n * unit)) / 100;
  return { label: !fresh ? "Price expired" : raw < unit ? "At risk" : raw < unit * 3n / 2n ? "Caution" : "Healthy", tone: !fresh ? "neutral" : raw < unit ? "risk" : raw < unit * 3n / 2n ? "caution" : "healthy", value: displayAmount(`${raw / unit}.${(raw % unit).toString().padStart(18,"0")}`,2), percent };
}
