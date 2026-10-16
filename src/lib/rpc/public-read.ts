// Public display data only. Never use browser results as proof of payment.
const publicRPC = "https://rpc.retium.org";
export async function publicRead(endpoint: string) {
  if (!/^\/(?:transaction\/tx_[0-9a-f]{32}|contract\/[0-9a-f]{64}|wallet\/rete[0-9a-f]{68}(?:\/transactions\?limit=20&offset=\d+)?)$/.test(endpoint)) {
    throw Error("Unsupported public read.");
  }
  let response: Response;
  try {
    response = await fetch(`${publicRPC}/api${endpoint}`, {
      method: "GET", credentials: "omit", redirect: "error", cache: "no-store",
      headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw Error("Could not read the public Retium API from this browser. Try again later.");
  }
  if (!response.ok) {
    throw Error(response.status === 404 ? "Not found on the current Retium network." : `Retium API unavailable (${response.status}). Try again later.`);
  }
  const text = await response.text();
  if (text.length > 1_500_000) throw Error("Explorer response is too large.");
  try { return JSON.parse(text); }
  catch { throw Error("Retium API returned an invalid response."); }
}
