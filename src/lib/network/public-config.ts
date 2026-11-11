/**
 * Browser-safe Retium network identity.
 * Keep wallet chain checks aligned with the server-side Network Registry.
 */
function readPublicInteger(value: string | undefined, fallback: number): number {
  if (!value || !/^[0-9]{1,9}$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export const RETIUM_CHAIN_ID = readPublicInteger(
  process.env.NEXT_PUBLIC_RETIUM_CHAIN_ID,
  3,
);
