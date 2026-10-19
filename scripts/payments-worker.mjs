import { safeWorkerError } from "./safe-worker-error.mjs";
import { createHash } from "node:crypto";
import { stableSecret, saveData, closeStorage } from "../src/lib/storage/store.mjs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const project = fileURLToPath(new URL("..", import.meta.url));
const dataDir = path.join(project, "data");
const keyPath = path.join(dataDir, "payments-worker.key");
const statusPath = path.join(dataDir, "payments-worker-status.json");
const once = process.argv.includes("--once");
// A shared database lets a trusted worker verify independently of Vercel RPC.
if (process.argv.includes("--direct") && !process.env.DATABASE_URL?.trim()) {
  throw new Error("Direct verification requires DATABASE_URL in .env.local, using the same database as Vercel.");
}
const direct = process.argv.includes("--direct") || (Boolean(process.env.DATABASE_URL?.trim()) && process.env.RETIUM_WORKER_MODE !== "http");
const endpoint = new URL("/api/payments", process.env.APP_URL || "http://localhost:3000");
if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
  throw new Error("APP_URL must be a valid HTTP(S) application URL.");
}
// A local TCP guard is released by the OS even after an unexpected process exit.
const guardPort = 35000 + (createHash("sha256").update(project.toLowerCase()).digest().readUInt16BE(0) % 20000);
const guard = net.createServer((socket) => socket.destroy());
let stopping = false;
const stopWait = new AbortController();
let state = { running: true, lastSeenAt: Date.now(), lastSuccessAt: null, pending: 0, needsReview: 0, pendingNotices: 0, lastError: null };
function log(text) { console.log(`[Payments worker] ${text}`); }
function stop() {
  if (stopping) return;
  stopping = true; stopWait.abort(); log("Stopping after the current check...");
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

async function saveStatus() {
  state.lastSeenAt = Date.now();
  try { await saveData(statusPath, state); }
  catch (error) { log(`Status persistence unavailable (${safeWorkerError(error)}). Will retry; verifier remains running.`); }
}
async function readKey() {
  return stableSecret(keyPath);
}

async function main() {
  await new Promise((resolve, reject) => {
    guard.once("error", reject);
    guard.listen({ host: "127.0.0.1", port: guardPort, exclusive: true }, resolve);
  });
  process.chdir(project);
  const key = await readKey();
  const directTick = direct
    ? await (await import("./direct-verifier.mjs")).createDirectVerifier(project)
    : null;
  let failures = 0;
  let lastSummary = "";
  log(direct ? "Direct verifier online. Shared database; RPC read from this worker host. No local web server required." : "HTTP worker online.");
  log("Watches saved payment and DEX TX IDs only; never signs or sends funds.");
  await saveStatus();
  try {
    do {
      let delay = 15_000;
      try {
        const response = directTick ? await directTick(key) : await fetch(endpoint, {
          method: "POST", redirect: "error",
          headers: { "Content-Type": "application/json", "X-Retium-Worker-Key": key },
          body: JSON.stringify({ action: "workerTick" }), signal: AbortSignal.timeout(50_000),
        });
        if (response.status === 401 || response.status === 403) {
          throw Object.assign(new Error("Worker authentication failed. Check that the background patch is installed in the same project as this worker."), { fatal: true });
        }
        if (!response.ok) throw new Error(`Application HTTP ${response.status}.`);
        const result = await response.json();
        if (result.ok !== true) throw new Error("Unexpected application response.");
        failures = 0;
        state.lastSuccessAt = Date.now();
        state.lastError = result.rpcError ? "RPC unavailable; queued payments will be retried." : null;
        state.pending = result.pending ?? 0;
        state.needsReview = result.needsReview ?? 0;
        state.pendingNotices = result.pendingNotices ?? 0;
        state.dexPending = result.dexPending ?? 0;
        state.dexPendingNotices = result.dexPendingNotices ?? 0;
        const summary = `Pending TX: ${state.pending}; needs review: ${state.needsReview}; pending confirmations: ${state.pendingNotices}; DEX pending: ${state.dexPending}; DEX notices: ${state.dexPendingNotices}.`;
        if (summary !== lastSummary || result.checked) { log(summary); lastSummary = summary; }
        if (result.rpcError) log("RPC check failed. Retrying later without confirming or resending payment.");
      } catch (error) {
        failures++;
        delay = Math.min(60_000, 15_000 * 2 ** Math.min(failures - 1, 2));
        state.lastError = "Application unreachable or check failed; no payment confirmed.";
        if (error?.fatal) { log(error.message); process.exitCode = 1; break; }
        log(`Verification check failed (${safeWorkerError(error)}). Retry in ${delay / 1000}s.`);
        if (once) process.exitCode = 1;
      }
      await saveStatus();
      if (once || stopping) break;
      try { await wait(delay, undefined, { signal: stopWait.signal }); } catch { /* Stop requested. */ }
    } while (!stopping);
  } finally {
    state.running = false;
    await saveStatus();
  }
}
main().catch((error) => {
  process.exitCode = 1;
  log(error?.code === "EADDRINUSE" ? "Another payments worker for this project is already running, or its local guard port is occupied." : `Worker startup failed (${safeWorkerError(error)}). Supervisor will retry.`);
}).finally(() => {
  if (guard.listening) guard.close();
  return closeStorage();
});
