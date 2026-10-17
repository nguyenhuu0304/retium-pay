// Read-only test from the actual worker host. No API key, wallet or database.
export async function probeRpc() {
  const base = new URL(process.env.RETIUM_RPC_URL || "https://rpc.retium.org");
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/")
    throw Error("Use an HTTPS RPC base URL without credentials or path.");
  const tx = "tx_ccd4869c6e54be0591c2d7c9ac66ed98";
  const dex = "a8a370858f29a78c07dd115a7ef123d93e1e3ef1caa3bb7c27565c8ffb14945c";
  for (const endpoint of ["/api/transaction/" + tx, "/api/contract/" + dex + "/query?method=list_pools&args="]) {
    const r = await fetch(new URL(endpoint, base), { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15000) });
    console.log(`RPC preflight: ${endpoint.startsWith("/api/transaction") ? "transaction" : "contract query"}; HTTP ${r.status}; ${r.headers.get("content-type") || "unknown content type"}`);
    if (!r.ok || !r.headers.get("content-type")?.includes("application/json")) throw Error("RPC host is not available from this server.");
    const text = await r.text();
    if (text.length > 1500000) throw Error("RPC response too large.");
    const data = JSON.parse(text);
    if (endpoint.startsWith("/api/transaction")) {
      if (data.tx_id !== tx || !data.sender || !data.action) throw Error("Sample TX was not returned. A testnet reset may require a current sample TX.");
    } else if (data.ok !== true || typeof data.output !== "string") throw Error("Contract query is unavailable.");
  }
}
