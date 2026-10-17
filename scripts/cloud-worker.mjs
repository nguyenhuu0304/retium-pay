import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { probeRpc } from "./rpc-preflight.mjs";
const project = fileURLToPath(new URL("..", import.meta.url));
process.chdir(project);
const mode = process.env.RETIUM_CLOUD_MODE || "probe";
async function main() {
  if (!["probe", "run"].includes(mode)) throw Error("RETIUM_CLOUD_MODE must be probe or run.");
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
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
  try {
    await client.connect();
    const result = await client.query("SELECT name FROM retium_pay_documents WHERE name IN ('payments.json','dex-intents.key','telegram-links.json')");
    if (result.rows.length !== 3) throw Error("Shared database is not prepared. Use the SAME imported Neon database as Vercel.");
  } catch { throw Error("Shared database check failed. Check DATABASE_URL and the existing import; credentials were not logged."); }
  finally { await client.end().catch(() => {}); }
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`, { signal: AbortSignal.timeout(15000), redirect: "error" });
  const bot = await response.json();
  if (!response.ok || bot.ok !== true) throw Error("Telegram token check failed.");
  console.log("Shared database and Telegram connection checks passed.");
  const children = [];
  let stopping = false;
  function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    for (const child of children) child.kill("SIGTERM");
    const force = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, 12000);
    force.unref();
  }
  process.on("SIGTERM", () => stop());
  process.on("SIGINT", () => stop());
  function start(script, args = []) {
    const child = spawn(process.execPath, [script, ...args], { cwd: project, env: process.env, stdio: "inherit" });
    children.push(child);
    child.on("error", () => { console.error("A background process could not start."); stop(1); });
    child.on("exit", (code) => { if (!stopping) { console.error(`Background process exited (${code ?? "signal"}); restarting the service is required.`); stop(1); } });
  }
  start("scripts/payments-worker.mjs", ["--direct"]);
  if (process.env.RETIUM_RUN_TELEGRAM_BOT === "true") start("scripts/telegram-bot.mjs");
  console.log("Cloud verifier running. Public users do not need your PC. Telegram polling: " + (process.env.RETIUM_RUN_TELEGRAM_BOT === "true" ? "enabled" : "disabled"));
}
main().catch(() => { console.error("Cloud startup checks failed. Inspect the safe preflight messages and service variables. No transaction was signed or sent."); process.exitCode = 1; });
