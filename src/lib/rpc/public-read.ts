// Browser-side public reads go through our same-origin API proxy.
// This keeps the active RPC endpoint in one server-side registry and avoids
// browser bundles silently retaining an old network URL after an upgrade.
const SAFE_PATH =
  /^\/(?:transaction\/tx_[0-9a-f]{32}|contract\/[0-9a-f]{64}(?:\/query\?method=(?:list_pools|get_pool|get_lp_balance|balance_of|allowance|market|position)&args=[0-9A-Za-z_,]*)?|wallet\/rete[0-9a-f]{68}(?:\/transactions\?limit=20&offset=\d+)?)$/;

export async function publicRead(endpoint: string, signal?: AbortSignal) {
  if (endpoint.length > 600 || !SAFE_PATH.test(endpoint)) {
    throw new Error("Unsupported public read.");
  }

  let response: Response;
  try {
    response = await fetch(
      `/api/network/read?path=${encodeURIComponent(endpoint.slice(1))}`,
      {
        method: "GET",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      },
    );
  } catch {
    throw new Error(
      "Could not read the configured Retium network. Try again later.",
    );
  }

  const raw = await response.text();
  if (raw.length > 1_500_000)
    throw new Error("Explorer response is too large.");

  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Retium API returned an invalid response.");
  }

  if (!response.ok) {
    throw new Error(
      typeof data?.error === "string"
        ? data.error
        : `Retium API unavailable (${response.status}). Try again later.`,
    );
  }
  return data;
}
