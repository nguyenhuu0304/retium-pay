// Read-only deployment diagnostic. No database, credentials, signatures or transfers.
let pending: { until: number; result: Promise<unknown> } | undefined;
const sample = "tx_fc4507f0564e6498f7a3378721516581";

async function inspectRPC() {
  let base: URL;
  try {
    base = new URL((process.env.RETIUM_RPC_URL || "https://rpc.retium.org").trim());
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw Error();
  } catch {
    return { ok: false, configuration: "Invalid RPC URL; use https://rpc.retium.org without quotes, credentials, path or query." };
  }
  const endpoint = `${base.toString().replace(/\/$/, "")}/api/transaction/${sample}`;
  const attempts = [];
  for (const identified of [false, true]) {
    try {
      const response = await fetch(endpoint, {
        cache: "no-store",
        redirect: "manual",
        headers: identified ? { Accept: "application/json", "User-Agent": "RetiumPay/0.1 (+https://retium-pay.vercel.app)" } : {},
        signal: AbortSignal.timeout(12_000),
      });
      const text = (await response.text()).slice(0, 100_000);
      let validTransaction = false;
      try { validTransaction = JSON.parse(text)?.tx_id === sample; } catch { /* A block page is not JSON. */ }
      const cloudflareCode = text.match(/(?:error(?: code)?[:\s]+|<span[^>]*>)(10\d{2})(?:\b|<)/i)?.[1] || null;
      attempts.push({
        client: identified ? "RetiumPay identified client" : "Node default client",
        httpStatus: response.status,
        contentType: response.headers.get("content-type"),
        server: response.headers.get("server"),
        rayId: response.headers.get("cf-ray"),
        cloudflareCode,
        validTransaction,
        challenge: /just a moment|cf-chl-|challenge-platform/i.test(text),
        redirected: response.status >= 300 && response.status < 400,
      });
    } catch {
      attempts.push({ client: identified ? "RetiumPay identified client" : "Node default client", connectionFailed: true });
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    rpcHost: base.hostname,
    rpcPathIsRoot: base.pathname === "/",
    expectedRPCHost: base.hostname === "rpc.retium.org",
    vercelRegion: process.env.VERCEL_REGION || "local",
    attempts,
  };
}

export async function GET(request: Request) {
  void request.url; // Execute per request with Cache Components; no static prerendering.
  if (!pending || pending.until < Date.now()) {
    pending = { until: Date.now() + 60_000, result: inspectRPC() };
  }
  return Response.json(await pending.result, { headers: { "Cache-Control": "no-store" } });
}
export const maxDuration = 40;
