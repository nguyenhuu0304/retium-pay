import { readPool } from "./pool-read";
import { parseReviewSnapshot, parseDeploymentAccount } from "./review-input";
import { blake3 } from "@noble/hashes/blake3.js";
import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { readFile as readAsset } from "node:fs/promises";
import { readData as readFile, withDocument, stableSecret } from "../storage/store.mjs";
import path from "node:path";
import {
  UNIT,
  atomic,
  decimalAtomic,
  fmt,
  DEX,
  makePlan,
  type Plan,
  type Pool,
} from "./math";
const directory = path.join(process.cwd(), "data");
const rpc = (process.env.RETIUM_RPC_URL || "https://rpc.retium.org").replace(
  /\/$/,
  "",
);
export async function rpcRead(endpoint: string) {
  const response = await fetch(`${rpc}/api/${endpoint}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  const data = await response.json();
  if (!response.ok)
    throw Error(`RPC unavailable (${response.status}). Try again later.`);
  return data;
}
async function query(contract: string, method: string, args: string[] = []) {
  // The current node treats commas as argument separators before URL decoding.
  // Restrict each value to plain IDs/names/numbers, then preserve literal commas.
  const plain = /^[0-9A-Za-z_]+$/;
  if (
    !/^[0-9a-f]{64}$/.test(contract) ||
    !plain.test(method) ||
    args.some((arg) => !plain.test(arg))
  ) {
    throw Error("Invalid contract query arguments.");
  }
  const data = await rpcRead(
    `contract/${contract}/query?method=${method}&args=${args.join(",")}`,
  );
  if (data.ok !== true)
    throw Error(String(data.error || "Contract query failed.").slice(0, 200));
  if (typeof data.output !== "string")
    throw Error("Unexpected contract query response.");
  return data.output;
}
export async function pools(cursor: string) {
  if (!/^[0-9]{1,12}$/.test(cursor)) throw Error("Invalid cursor.");
  const data = JSON.parse(
    await query(DEX, "list_pools", cursor === "0" ? [] : [cursor]),
  );
  const list = Array.isArray(data) ? data : data.pools;
  if (!Array.isArray(list)) throw Error("Invalid pool list.");
  const next =
    !Array.isArray(data) &&
    Number.isSafeInteger(data.next) &&
    data.next > Number(cursor)
      ? String(data.next)
      : null;
  return {
    pools: list
      .filter((p: Pool) => p && /^[0-9a-f]{64}$/.test(p.token_b))
      .slice(0, 100)
      .map((p: Pool) => ({
        token: p.token_b,
        reserveRtm: atomic(p.reserve_rtm).toString(),
      })),
    next,
  };
}
export async function tokenInfo(token: string) {
  const data = await rpcRead(`contract/${token}`);
  if (data.contract_id !== token) throw Error("Wrong token returned by RPC.");
  const meta = data.rcp_metadata,
    traits: unknown[] = meta?.traits || [],
    caps: unknown[] = meta?.capabilities || [];
  if (
    !traits.includes("fungible") ||
    !["approve", "transfer_from", "balance_of", "allowance"].every((c) =>
      caps.includes(c),
    )
  )
    throw Error("This contract is not a supported fungible token.");
  if (!traits.includes("decimals:18"))
    throw Error(
      "This release supports only tokens explicitly declaring 18 decimals.",
    );
  const symbol =
    traits
      .find(
        (x): x is string => typeof x === "string" && x.startsWith("symbol:"),
      )
      ?.slice(7) || token.slice(0, 10);
  return {
    symbol:
      /^[A-Za-z0-9._-]{1,20}$/.test(symbol) && symbol !== "RTM"
        ? symbol
        : `Token ${token.slice(0, 10)}`,
    codeHash: data.code_hash,
  };
}
export async function market(token: string, wallet: string) {
  const info = await tokenInfo(token);
  const pool = await readPool(query, token);
  const account = await rpcRead(`wallet/${wallet}`);
  const balanceToken = atomic(await query(token, "balance_of", [wallet]));
  const allowance = atomic(await query(token, "allowance", [wallet, DEX]));
  const position = pool
    ? JSON.parse(await query(DEX, "get_lp_balance", [token, wallet]))
    : { lp_balance: "0", locked: "0", until_ms: 0 };
  const lp = atomic(position.lp_balance),
    locked = atomic(position.locked);
  const untilMs = Number(position.until_ms);
  if (
    !Number.isSafeInteger(untilMs) ||
    untilMs < -1 ||
    (locked > 0n && untilMs < 0) ||
    locked > lp
  )
    throw Error("Invalid LP lock state.");
  const nonce = account.nonce ?? account.next_nonce;
  if (!Number.isSafeInteger(nonce) || nonce < 0)
    throw Error("RPC did not return a usable wallet nonce.");
  // spendable and balance_rtm are decimal RTM in the current wallet API.
  const balanceRtm = decimalAtomic(account.spendable ?? account.balance_rtm);
  return {
    info,
    pool,
    balanceToken,
    allowance,
    lp,
    locked,
    untilMs,
    nonce,
    balanceRtm,
  };
}
async function key() {
  return stableSecret(path.join(directory, "dex-intents.key"));
}
export async function prepare(body: Record<string, unknown>) {
  const token = String(body.token || ""),
    wallet = String(body.wallet || "");
  if (!/^[0-9a-f]{64}$/.test(token) || !/^rete[0-9a-f]{68}$/.test(wallet))
    throw Error("Enter a token contract and connect a Retium wallet.");
  // A ticket authorizes tracking this intent, not trusting browser balances or finality.
  // Contract execution and independent TX verification remain authoritative.
  const m = body.reviewSnapshot === undefined
    ? await market(token, wallet)
    : parseReviewSnapshot(body.reviewSnapshot, token, wallet, Date.now());
  const plan = makePlan({
    wallet,
    token,
    symbol: m.info.symbol,
    action: String(body.action),
    direction: String(body.direction),
    amount: String(body.amount || ""),
    tokenAmount: String(body.tokenAmount || ""),
    shares: String(body.shares || ""),
    lockDays: String(body.lockDays || ""),
    bps: Number(body.bps),
    ...m,
    now: Date.now(),
  });
  const payload = Buffer.from(JSON.stringify(plan)).toString("base64url"),
    sig = createHmac("sha256", await key())
      .update(payload)
      .digest("hex");
  return {
    plan,
    ticket: `${payload}.${sig}`,
    market: {
      symbol: m.info.symbol,
      codeHash: m.info.codeHash,
      pool: m.pool,
      lp: m.lp.toString(),
      locked: m.locked.toString(),
      untilMs: m.untilMs,
      balanceRtm: m.balanceRtm.toString(),
      balanceToken: m.balanceToken.toString(),
    },
  };
}
export async function stakeSummary(wallet: string) {
  if (!/^rete[0-9a-f]{68}$/.test(wallet))
    throw Error("Connect a Retium wallet.");
  const account = await rpcRead(`wallet/${wallet}`);
  const balance = String(account.balance_rtm ?? "");
  const pie = account.balance_pie == null ? null : String(account.balance_pie);
  decimalAtomic(balance);
  if (pie !== null) decimalAtomic(pie);
  return { wallet, balance, pie, readAt: Date.now() };
}
export async function prepareDeploy(body: Record<string, unknown>) {
  const wallet = String(body.wallet || ""),
    name = String(body.name || "").trim(),
    symbol = String(body.symbol || "")
      .trim()
      .toUpperCase(),
    supply = String(body.supply || "").trim();
  if (!/^rete[0-9a-f]{68}$/.test(wallet))
    throw Error("Connect a Retium wallet.");
  if (
    name.length < 2 ||
    name.length > 48 ||
    !/^[A-Za-z]+( [A-Za-z]+)*$/.test(name)
  )
    throw Error("Use a name of 2–48 English letters and single spaces.");
  if (!/^[A-Z0-9]{2,8}$/.test(symbol) || ["RTM", "RTD"].includes(symbol))
    throw Error("Use 2–8 letters or digits; RTM and RTD are reserved here.");
  if (!/^[1-9][0-9]{0,14}$/.test(supply))
    throw Error("Supply must be a positive whole number, up to 15 digits.");
  const bytes = await readAsset(
    path.join(process.cwd(), "public/contracts/meme_token.wasm"),
  );
  if (
    createHash("sha256").update(bytes).digest("hex") !==
    "14d5b587d090135f20c043e0ec0a40969b498321a5f9040f79b282ee53585122"
  )
    throw Error("Token template checksum mismatch. Reinstall this patch.");
  const metadata = {
    name,
    symbol,
    rcp_type: "Token",
    traits: ["fungible"],
    capabilities: [
      "transfer",
      "approve",
      "transfer_from",
      "balance_of",
      "allowance",
    ],
    lockable_fields: [],
    weight: 5,
    version: "v1.0.0",
    initial_supply: supply,
    decimals: "18",
  };
  // Matches Web Wallet Connect's contract ID derivation (weight byte + ID metadata).
  const contractId = Buffer.from(
    blake3(
      Buffer.concat([
        bytes,
        Buffer.from(wallet),
        Buffer.from([5]),
        Buffer.from(name),
        Buffer.from(symbol),
        Buffer.from("Token"),
        Buffer.from("fungible"),
      ]),
    ),
  ).toString("hex");
  const account = body.accountSnapshot === undefined
    ? await rpcRead(`wallet/${wallet}`)
    : parseDeploymentAccount(body.accountSnapshot, wallet, Date.now());
  if (!Number.isSafeInteger(account.nonce) || account.nonce < 0)
    throw Error("Invalid wallet nonce.");
  if (decimalAtomic(String(account.spendable ?? account.balance_rtm)) < UNIT)
    throw Error(
      "Keep at least 1 RTM available as a fee buffer. Wallet shows the actual fee.",
    );
  const now = Date.now();
  const plan: Plan = {
    wallet,
    token: contractId,
    symbol,
    action: "deploy",
    call: { contractId, method: "deploy", args: [], amountAtomic: "0" },
    nonce: account.nonce,
    createdAt: now,
    expiresAt: now + 60_000,
    deadline: now + 1200_000,
    summary: [
      `Name: ${name}`,
      `Symbol: ${symbol}`,
      `Initial supply: ${supply}`,
      "Decimals: 18",
      "Standard fungible token template in Retium Pay. This does not create a pool.",
      "Keep the same wallet account selected when signing.",
    ],
    approval: false,
    deployment: {
      codeHash: Buffer.from(blake3(bytes)).toString("hex"),
      metadata,
    },
  };
  const payload = Buffer.from(JSON.stringify(plan)).toString("base64url");
  return {
    plan,
    ticket: `${payload}.${createHmac("sha256", await key())
      .update(payload)
      .digest("hex")}`,
    wasmBase64: bytes.toString("base64"),
  };
}
export async function identity(request: Request) {
  const token =
    request.headers
      .get("cookie")
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("retium_requests_session="))
      ?.slice("retium_requests_session=".length) || "";
  if (!/^[0-9a-f]{64}$/.test(token))
    throw Error("Sign in with your wallet for Telegram tracking.");
  const state = JSON.parse(
    await readFile(path.join(directory, "payments.json"), "utf8"),
  );
  const session =
    state.listSessions?.[createHash("sha256").update(token).digest("hex")];
  if (!session || session.expiresAt <= Date.now())
    throw Error("Wallet session expired. Sign in again.");
  return String(session.address);
}
export type DexJob = {
  txId: string;
  wallet: string;
  plan: Plan;
  registeredAt: number;
  state: "pending" | "confirmed" | "failed" | "review";
  notice: "pending" | "sending" | "sent" | "failed" | "unknown" | "unlinked";
  nextCheck: number;
  failures: number;
  error?: string;
  block?: string;
  timestamp?: number;
  claimedAt?: number;
};
type Store = { jobs: Record<string, DexJob> };
async function store<T>(fn: (s: Store) => T | Promise<T>): Promise<T> {
  return withDocument(path.join(directory, "dex-transactions.json"), () => ({ jobs: {} } as Store), async (state: Store) => {
    if (!state.jobs || typeof state.jobs !== "object") throw Error("Invalid DEX storage");
    return fn(state);
  });
}
export async function register(ticket: string, txId: string, wallet: string) {
  if (!/^tx_[0-9a-f]{32}$/.test(txId) || ticket.length > 10000)
    throw Error("Invalid transaction registration.");
  const [payload, sig, ...extra] = ticket.split("."),
    expected = createHmac("sha256", await key())
      .update(payload || "")
      .digest();
  if (
    extra.length ||
    !/^[0-9a-f]{64}$/.test(sig || "") ||
    !timingSafeEqual(Buffer.from(sig, "hex"), expected)
  )
    throw Error("Invalid preview ticket.");
  const plan = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as Plan;
  if (plan.wallet !== wallet)
    throw Error("Preview does not belong to this wallet.");
  return store((s) => {
    if (s.jobs[txId]) {
      if (s.jobs[txId].wallet !== wallet)
        throw Error("Transaction already registered.");
      return s.jobs[txId];
    }
    // Expiry blocks NEW registrations, not reading an already-saved TX.
    // The HMAC, authenticated wallet and existing job ownership were checked above.
    if (Date.now() > plan.deadline + 3600_000)
      throw Error("Preview has expired. This TX has not been registered.");
    if (
      Object.values(s.jobs).filter(
        (j) => j.wallet === wallet && j.state === "pending",
      ).length >= 5
    )
      throw Error(
        "Resolve existing pending transactions before submitting more.",
      );
    if (Object.keys(s.jobs).length >= 10000)
      throw Error("Local DEX store full.");
    const j: DexJob = {
      txId,
      wallet,
      plan,
      registeredAt: Date.now(),
      state: "pending",
      notice: "pending",
      nextCheck: 0,
      failures: 0,
    };
    s.jobs[txId] = j;
    return j;
  });
}
export async function job(txId: string, wallet: string) {
  return store((s) => {
    const j = s.jobs[txId];
    if (!j || j.wallet !== wallet)
      throw Error("Transaction not found for this wallet.");
    return j;
  });
}
export function verifyDexTx(tx: Record<string, unknown>, j: DexJob) {
  const finality = tx.finality || tx.status;
  if (["Rejected", "Voided", "Failed"].includes(String(finality)))
    return "failed";
  if (finality !== "HardFinal") return "pending";
  if (j.plan.deployment) {
    if (
      tx.tx_id !== j.txId ||
      tx.sender !== j.wallet ||
      tx.action !== "deploy" ||
      tx.recipient !== j.plan.call.contractId ||
      tx.nonce !== j.plan.nonce ||
      tx.amount !== "0"
    )
      throw Error("Deployment does not match the preview. Check the Explorer.");
    if (
      typeof tx.timestamp !== "number" ||
      !Number.isSafeInteger(tx.timestamp) ||
      tx.timestamp * 1000 < j.plan.createdAt - 30_000 ||
      tx.timestamp * 1000 > Date.now() + 60_000
    )
      throw Error("Unexpected deployment timestamp.");
    if (
      tx.exec_error ||
      tx.rejection_reason ||
      (tx.exec_status && tx.exec_status !== "ok")
    )
      return "failed";
    if (tx.exec_status !== "ok")
      throw Error(
        "Deployment execution status is not available yet. Check the Explorer.",
      );
    return "confirmed";
  }
  if (
    tx.tx_id !== j.txId ||
    tx.sender !== j.wallet ||
    tx.action !== "call" ||
    tx.recipient !== j.plan.call.contractId ||
    tx.nonce !== j.plan.nonce
  )
    throw Error(
      "Transaction does not match the prepared contract call. Review in the Explorer.",
    );
  const call = tx.call as {
    contract?: string;
    method?: string;
    args?: unknown;
  } | null;
  if (
    call?.contract !== j.plan.call.contractId ||
    call?.method !== j.plan.call.method ||
    tx.amount !== j.plan.call.amountAtomic
  )
    throw Error("Contract, method or attached RTM does not match the preview.");
  if (call?.args !== undefined) {
    const args = Array.isArray(call.args)
      ? call.args.map(String).join(",")
      : call.args;
    if (args !== j.plan.call.args.join(","))
      throw Error("Contract arguments do not match the preview.");
  }
  const timestamp = tx.timestamp;
  if (
    typeof timestamp !== "number" ||
    !Number.isSafeInteger(timestamp) ||
    timestamp * 1000 < j.plan.createdAt - 30_000 ||
    timestamp * 1000 > Date.now() + 60_000
  )
    throw Error("Unexpected transaction timestamp.");
  if (tx.exec_error || tx.rejection_reason) return "failed";
  if (tx.exec_status !== "ok" || (tx.status && tx.status !== "HardFinal"))
    return "failed";
  return "confirmed";
}
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export async function dexTick(target?: { txId: string; wallet: string }) {
  const matches = (j: DexJob) =>
    !target || (j.txId === target.txId && j.wallet === target.wallet);
  const snapshot = await store((s) => {
    for (const j of Object.values(s.jobs)) {
      if (j.notice === "sending" && (j.claimedAt || 0) < Date.now() - 60_000)
        j.notice = "unknown";
    }
    if (
      process.env.TELEGRAM_BOT_TOKEN &&
      Object.values(s.jobs).some(
        (j) => matches(j) && j.state !== "pending" && j.notice === "pending",
      )
    )
      return null;
    const j = Object.values(s.jobs)
      .filter(
        (j) => matches(j) && j.state === "pending" && j.nextCheck <= Date.now(),
      )
      .sort((a, b) => a.nextCheck - b.nextCheck)[0];
    if (!j) return null;
    j.nextCheck = Date.now() + 60_000;
    return structuredClone(j);
  });
  if (snapshot) {
    try {
      const tx = await rpcRead(`transaction/${snapshot.txId}`);
      let state: DexJob["state"] = "review",
        error = "";
      try {
        state = verifyDexTx(tx, snapshot);
      } catch (e) {
        error = e instanceof Error ? e.message : "Verification failed.";
      }
      if (state === "confirmed" && snapshot.plan.deployment) {
        const contract = await rpcRead(
          `contract/${snapshot.plan.call.contractId}`,
        );
        if (
          contract.contract_id !== snapshot.plan.call.contractId ||
          contract.code_hash !== snapshot.plan.deployment.codeHash
        ) {
          state = "review";
          error =
            "Deployed contract code does not match the approved template.";
        }
      }
      await store((s) => {
        const j = s.jobs[snapshot.txId];
        if (j.state !== "pending") return;
        j.state = state;
        j.error = error;
        j.failures = 0;
        j.nextCheck = Date.now() + 15_000;
        if (state === "confirmed") {
          if (
            typeof tx.block_id === "string" &&
            /^[0-9]{1,40}$/.test(tx.block_id)
          )
            j.block = tx.block_id;
          else if (Number.isSafeInteger(tx.block_id))
            j.block = String(tx.block_id);
          j.timestamp = tx.timestamp;
        }
      });
    } catch {
      await store((s) => {
        const j = s.jobs[snapshot.txId];
        j.failures++;
        j.nextCheck =
          Date.now() + Math.min(300_000, 15_000 * 2 ** Math.min(j.failures, 5));
        j.error = "RPC unavailable. No confirmation yet.";
        if (Date.now() - j.registeredAt > 24 * 3600_000) {
          j.state = "review";
          j.error =
            "Still unconfirmed after 24 hours. Check the Explorer before doing anything else.";
        }
      });
    }
    return true; // Notification is sent on a later tick, keeping worker calls short.
  }
  if (!process.env.TELEGRAM_BOT_TOKEN) return false;
  const ready = await store((s) => {
    const j = Object.values(s.jobs).find(
      (j) => matches(j) && j.state !== "pending" && j.notice === "pending",
    );
    if (!j) return null;
    j.notice = "sending";
    j.claimedAt = Date.now();
    return structuredClone(j);
  });
  if (!ready) return false;
  let notice: DexJob["notice"] = "unknown";
  try {
    const links = JSON.parse(
      await readFile(path.join(directory, "telegram-links.json"), "utf8"),
    ).links;
    const chatId = links?.[ready.wallet]?.chatId;
    if (!chatId) notice = "unlinked";
    else {
      const labels: Record<string, string> = {
        swap: "Swap",
        add_liquidity: "Add liquidity",
        create_pool: "Create pool",
        remove_liquidity: "Remove liquidity",
        lock_liquidity: "Lock liquidity",
        approve: "Token approval",
        deploy: "Deploy token",
      };
      const lines = [
        `<b>Retium Pay · ${ready.state === "confirmed" ? (ready.plan.deployment ? "Token deployed" : "Contract call confirmed") : "Transaction needs attention"}</b>`,
        "",
        `<b>Action:</b> ${labels[ready.plan.call.method] || "Contract call"}`,
        `<b>Token (preview):</b> ${escapeHtml(ready.plan.symbol)}`,
        `<b>Wallet:</b> <code>${ready.wallet}</code>`,
        `<b>Contract:</b> <code>${ready.plan.call.contractId}</code>`,
        `<b>Attached RTM:</b> ${ready.plan.call.amountAtomic === "0" ? "0" : fmt(BigInt(ready.plan.call.amountAtomic))}`,
        `<b>Status:</b> ${ready.state === "confirmed" ? "HardFinal · execution ok" : escapeHtml(ready.state)}`,
        `<b>TX:</b> <code>${ready.txId}</code>`,
      ];
      if (ready.block) lines.push(`<b>Block:</b> <code>${ready.block}</code>`);
      if (ready.timestamp)
        lines.push(
          `<b>Time (Australia/Sydney):</b> ${new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", dateStyle: "short", timeStyle: "long" }).format(ready.timestamp * 1000)}`,
        );
      if (ready.error) lines.push(escapeHtml(ready.error));
      lines.push(
        "",
        ready.plan.deployment
          ? "Testnet only. Deployment and template code verified. No liquidity pool has been created."
          : "Testnet only. The token is from the preview; exact swap outputs and LP changes require a receipt.",
      );
      const response = await fetch(
        `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            parse_mode: "HTML",
            text: lines.join("\n"),
            link_preview_options: { is_disabled: true },
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      const data = await response.json();
      notice = response.ok && data.ok === true ? "sent" : "failed";
    }
  } catch {
    /* An acknowledgement can be lost after a successful send; never duplicate automatically. */
  }
  await store((s) => {
    s.jobs[ready.txId].notice = notice;
  });
  return true;
}

// Token names are loaded only when the user opens or pages through the picker.
const pickerCache = new Map<
  string,
  { expires: number; symbol: string; codeHash: string }
>();
export async function tokenPage(cursor: string, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100)
    throw Error("Invalid token page.");
  const page = await pools(cursor);
  const selected = page.pools.slice(offset, offset + 12);
  const tokens: { token: string; symbol: string; supported: boolean }[] = [];
  for (let start = 0; start < selected.length; start += 4) {
    const batch = selected.slice(start, start + 4);
    const results = await Promise.allSettled(
      batch.map(async (item) => {
        let info = pickerCache.get(item.token);
        if (!info || info.expires < Date.now()) {
          const fresh = await tokenInfo(item.token);
          info = { ...fresh, expires: Date.now() + 300_000 };
          if (pickerCache.size >= 500)
            pickerCache.delete(pickerCache.keys().next().value!);
          pickerCache.set(item.token, info);
        }
        return { token: item.token, symbol: info.symbol, supported: true };
      }),
    );
    results.forEach((result, index) =>
      tokens.push(
        result.status === "fulfilled"
          ? result.value
          : {
              token: batch[index].token,
              symbol: "Unavailable",
              supported: false,
            },
      ),
    );
  }
  const nextOffset = offset + selected.length;
  const next =
    nextOffset < page.pools.length
      ? { cursor, offset: nextOffset }
      : page.next
        ? { cursor: page.next, offset: 0 }
        : null;
  return { tokens, next };
}
export async function marketSummary(token: string, wallet: string) {
  if (!/^[0-9a-f]{64}$/.test(token) || !/^rete[0-9a-f]{68}$/.test(wallet))
    throw Error("Select a token and connect a wallet.");
  const m = await market(token, wallet);
  return {
    token,
    wallet,
    symbol: m.info.symbol,
    codeHash: m.info.codeHash,
    pool: m.pool,
    lp: m.lp.toString(),
    locked: m.locked.toString(),
    untilMs: m.untilMs,
    balanceRtm: m.balanceRtm.toString(),
    balanceToken: m.balanceToken.toString(),
    readAt: Date.now(),
  };
}

export async function queueSummary() {
  return store((s) => ({
    dexPending: Object.values(s.jobs).filter(j => j.state === "pending").length,
    dexPendingNotices: Object.values(s.jobs).filter(j => j.state !== "pending" && j.notice === "pending").length,
  }));
}
