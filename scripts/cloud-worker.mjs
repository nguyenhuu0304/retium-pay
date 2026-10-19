import { setTimeout as wait } from "node:timers/promises";
import { safeWorkerError } from "./safe-worker-error.mjs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { probeRpc } from "./rpc-preflight.mjs";
const project = fileURLToPath(new URL("..", import.meta.url));
process.chdir(project);
const mode = process.env.RETIUM_CLOUD_MODE || "probe";
let stage = "configuration";
let shutdown = false;
const startupAbort = new AbortController();
process.on("SIGTERM", () => { shutdown = true; startupAbort.abort(); });
process.on("SIGINT", () => { shutdown = true; startupAbort.abort(); });
async function main() {
  if (!["probe", "run"].includes(mode)) throw Error("RETIUM_CLOUD_MODE must be probe or run.");
  stage = "RPC preflight";
  await probeRpc();
  if (mode === "probe") {
    console.log("RPC_PREFLIGHT_OK. Probe only: no database changes, Telegram messages or transactions. Set RETIUM_CLOUD_MODE=run only after configuring secrets and stopping old workers.");
    return;
  }
  for (const key of ["DATABASE_URL", "TELEGRAM_BOT_TOKEN", "APP_URL"])
    if (!process.env[key]?.trim()) throw Error(`Missing ${key}. Configure it in server Variables.`);
  const u = new URL(process.env.APP_URL);
  if (u.protocol !== "https:" || u.username || u.password) throw Error("APP_URL must be the public HTTPS site.");
  // Read-only connection test: do not initialize an unrelated/empty database.
  stage = "shared database connection and imported documents";
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
  try {
    await client.connect();
    const result = await client.query("SELECT name FROM retium_pay_documents WHERE name IN ('payments.json','dex-intents.key','telegram-links.json')");
    if (result.rows.length !== 3) throw Error("Shared database is not prepared. Use the SAME imported Neon database as Vercel.");
  } catch (error) { throw error; }
  finally { await client.end().catch(() => {}); }
  stage = "Telegram getMe connection";
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`, { signal: AbortSignal.timeout(15000), redirect: "error" });
  const bot = await response.json();
  if (!response.ok || bot.ok !== true) throw Error("Telegram token check failed.");
  console.log("Shared database and Telegram connection checks passed.");
  const children = new Set();
  const restarts = new Map();
  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    for (const timer of restarts.values()) clearTimeout(timer);
    restarts.clear();
    for (const child of children) child.kill("SIGTERM");
    const force = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, 12000);
    force.unref();
  }
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  function start(script, args = [], failures = 0) {
    if (stopping || shutdown) return;
    const started = Date.now();
    const child = spawn(process.execPath, [script, ...args], { cwd: project, env: process.env, stdio: "inherit" });
    children.add(child);
    child.on("error", (error) => console.error(`Background process ${script}: ${safeWorkerError(error)}.`));
    child.on("close", (code) => {
      children.delete(child);
      if (stopping || shutdown) return;
      const count = Date.now() - started > 60000 ? 0 : failures + 1;
      const delay = Math.min(60000, 5000 * 2 ** Math.min(count, 4));
      console.error(`Background process ${script} exited (${code ?? "signal"}). Restarting only this process in ${delay / 1000}s.`);
      const timer = setTimeout(() => { restarts.delete(script); start(script, args, count); }, delay);
      restarts.set(script, timer);
    });
  }
  start("scripts/payments-worker.mjs", ["--direct"]);
  if (process.env.RETIUM_RUN_TELEGRAM_BOT === "true") start("scripts/telegram-bot.mjs");
  console.log("Cloud verifier running. Public users do not need your PC. Telegram polling: " + (process.env.RETIUM_RUN_TELEGRAM_BOT === "true" ? "enabled" : "disabled"));
}
async function boot() {
  let failures = 0;
  while (!shutdown) {
    try { await main(); return; }
    catch (error) {
      const delay = Math.min(60000, 5000 * 2 ** Math.min(failures++, 4));
      console.error(`Cloud startup failed at ${stage} (${safeWorkerError(error)}). Retrying in ${delay / 1000}s. No transaction sent.`);
      if (mode === "probe") { process.exitCode = 1; return; }
      try { await wait(delay, undefined, { signal: startupAbort.signal }); } catch { return; }
    }
  }
}
await boot();
