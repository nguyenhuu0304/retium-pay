import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const project = fileURLToPath(new URL("..", import.meta.url));
const dataDir = path.join(project, "data");
const keyPath = path.join(dataDir, "payments-worker.key");
const statusPath = path.join(dataDir, "payments-worker-status.json");
const once = process.argv.includes("--once");
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
  const temp = `${statusPath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  await rename(temp, statusPath);
}
async function readKey() {
  await mkdir(dataDir, { recursive: true });
  try {
    const file = await open(keyPath, "wx", 0o600);
    try { await file.writeFile(randomBytes(32).toString("hex"), "utf8"); await file.sync(); }
    finally { await file.close(); }
  } catch (error) { if (error?.code !== "EEXIST") throw error; }
  const key = (await readFile(keyPath, "utf8")).trim();
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Worker key file is invalid. Do not edit it manually.");
  return key;
}
async function main() {
  await new Promise((resolve, reject) => {
    guard.once("error", reject);
    guard.listen({ host: "127.0.0.1", port: guardPort, exclusive: true }, resolve);
  });
  const key = await readKey();
  let failures = 0;
  let lastSummary = "";
  log("Online. Watches saved payment TX IDs only; never signs or sends RTM.");
  await saveStatus();
  try {
    do {
      let delay = 15_000;
      try {
        const response = await fetch(endpoint, {
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
        const summary = `Pending TX: ${state.pending}; needs review: ${state.needsReview}; pending confirmations: ${state.pendingNotices}.`;
        if (summary !== lastSummary || result.checked) { log(summary); lastSummary = summary; }
        if (result.rpcError) log("RPC check failed. Retrying later without confirming or resending payment.");
      } catch (error) {
        failures++;
        delay = Math.min(60_000, 15_000 * 2 ** Math.min(failures - 1, 2));
        state.lastError = "Application unreachable or check failed; no payment confirmed.";
        if (error?.fatal) { log(error.message); process.exitCode = 1; break; }
        log(`Local application unavailable or check failed. Retry in ${delay / 1000}s.`);
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
  log(error?.code === "EADDRINUSE" ? "Another payments worker for this project is already running, or its local guard port is occupied." : "Could not start the worker. Check the project folder and data permissions.");
}).finally(() => {
  if (guard.listening) guard.close();
});
