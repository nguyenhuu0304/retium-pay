import { getRetiumNetworkConfig } from "../network/registry";

const MAX_RESPONSE_BYTES = 1_500_000;
const SAFE_PATH =
  /^(?:transaction\/tx_[0-9a-f]{32}|contract\/[0-9a-f]{64}(?:\/query\?method=(?:list_pools|get_pool|get_lp_balance|balance_of|allowance|market|position)&args=[0-9A-Za-z_,]*)?|wallet\/rete[0-9a-f]{68}(?:\/transactions\?limit=20&offset=\d+)?)$/;

export function validateRetiumReadPath(path: string): string {
  const normalized = path.replace(/^\/+/, "");
  if (
    normalized.length > 600 ||
    normalized.includes("#") ||
    normalized.includes("..") ||
    !SAFE_PATH.test(normalized)
  ) {
    throw new Error("Unsupported Retium read endpoint.");
  }
  return normalized;
}

/** Read-only RPC transport shared by server routes and workers. */
export async function rpcGet<T = unknown>(
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const config = getRetiumNetworkConfig();
  if (!config.rpcUrl) throw new Error("Retium RPC URL is not configured.");
  const safePath = validateRetiumReadPath(path);
  let response: Response;
  try {
    response = await fetch(`${config.rpcUrl}/api/${safePath}`, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(12_000)])
        : AbortSignal.timeout(12_000),
    });
  } catch {
    throw new Error("Could not connect to the configured Retium RPC.");
  }
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "Not found on the current Retium network."
        : `Retium RPC unavailable (${response.status}).`,
    );
  }
  const raw = await response.text();
  if (raw.length > MAX_RESPONSE_BYTES)
    throw new Error("Retium RPC response exceeded the size limit.");
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("Retium RPC returned invalid JSON.");
  }
}
