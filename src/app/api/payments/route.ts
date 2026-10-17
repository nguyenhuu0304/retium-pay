import {
  dexTick,
  queueSummary as dexQueueSummary,
  identity as dexIdentity,
  register as dexRegister,
  job as dexJob,
} from "../../../lib/dex/server";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readData as readFile, withDocument } from "../../../lib/storage/store.mjs";
import path from "node:path";
import { NextResponse } from "next/server";
import { blake3 } from "@noble/hashes/blake3.js";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";

import {
  authorizeStatement,
  detailsHash,
  requestStatement,
  validateTransfer,
} from "../../../lib/payments/validation";

type WalletLink = {
  address: string;
  userId: string;
  chatId: string;
  linkedAt: number;
};

type Payment = {
  id: string;
  recipient: string;
  payer: string;
  amountRtm: string;
  amountAtomic: string;
  description: string;
  createdAt: number;
  status: "requested" | "processing" | "paid";
  attempt?: Attempt;
  paidAt?: number;
  confirmedBlock?: string;
  chainTimestamp?: number;
  txId?: string;
  notification: "pending" | "sent" | "failed" | "unlinked" | "disabled";
  proofHash: string;
  payerLabel?: string;
  payerTelegram?: { displayName: string; username: string };
  notifyTelegram?: boolean;
  splitBillId?: string;
  splitTotalAtomic?: string;
  monitor?: {
    lastCheckedAt: number;
    nextCheckAt: number;
    failures: number;
    lastError?: string;
  };
};

type Challenge = {
  nonce: string;
  statement: string;
  payment: Payment;
  splitPayments?: Payment[];
  expiresAt: number;
};

type Attempt = {
  sessionHash: string;
  authorizedAt: number;
  expectedNonce: number;
  txId?: string;
  phase: "reserved" | "submitted" | "unknown";
  error?: string;
};
type PayChallenge = {
  id: string;
  nonce: string;
  statement: string;
  expectedNonce: number;
  createdAt: number;
  expiresAt: number;
  detailsHash: string;
};
type Notice = {
  paymentId: string;
  chatId: string;
  state: "pending" | "sending" | "sent" | "failed" | "unknown";
  claimedAt?: number;
};
type ListChallenge = {
  address: string;
  nonce: string;
  statement: string;
  createdAt: number;
  expiresAt: number;
};
type ListSession = { address: string; expiresAt: number };
type Contact = {
  address: string;
  userId: string;
  nickname: string;
  addedAt: number;
};
type State = {
  contacts?: Record<string, Contact[]>;
  listChallenges?: Record<string, ListChallenge>;
  listSessions?: Record<string, ListSession>;
  payChallenges?: Record<string, PayChallenge>;
  notices?: Record<string, Notice>;
  challenges: Record<string, Challenge>;
  payments: Record<string, Payment>;
};

class PaymentError extends Error {
  constructor(
    message: string,
    public status = 400,
    public retryAfterMs = 15_000,
  ) {
    super(message);
  }
}

const dataDirectory = path.join(process.cwd(), "data");
const statePath = path.join(dataDirectory, "payments.json");
const cookieName = "retium_payment_challenge";
const encoder = new TextEncoder();

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function hex(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("hex");
}

function decodeHex(value: unknown, length: number) {
  if (typeof value !== "string") {
    throw new PaymentError("Invalid signing response.");
  }

  const normalized = value.replace(/^0x/i, "");

  if (normalized.length !== length * 2 || !/^[0-9a-f]+$/i.test(normalized)) {
    throw new PaymentError("Invalid public key or signature.");
  }

  return Uint8Array.from(Buffer.from(normalized, "hex"));
}

function deriveAddress(publicKey: Uint8Array) {
  const addressHash = blake3(publicKey);
  const checksum = blake3(
    new Uint8Array([...encoder.encode("retium.addr.v1"), ...addressHash]),
  ).slice(0, 2);

  return `rete${hex(addressHash)}${hex(checksum)}`;
}

function validAddress(value: unknown): value is string {
  if (typeof value !== "string" || !/^rete[0-9a-f]{68}$/.test(value)) {
    return false;
  }

  const addressHash = Uint8Array.from(Buffer.from(value.slice(4, 68), "hex"));
  const checksum = blake3(
    new Uint8Array([...encoder.encode("retium.addr.v1"), ...addressHash]),
  ).slice(0, 2);

  return value.slice(68) === hex(checksum);
}

function parseAmount(value: unknown) {
  if (typeof value !== "string") {
    throw new PaymentError("Enter the RTM amount.");
  }

  const amount = value.trim();

  if (!/^(0|[1-9]\d{0,17})(\.\d{1,18})?$/.test(amount)) {
    throw new PaymentError(
      "Use a positive decimal amount with up to 18 decimal places.",
    );
  }

  const [whole, fraction = ""] = amount.split(".");
  const atomic = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));

  if (atomic <= 0n) {
    throw new PaymentError("The amount must be greater than zero.");
  }

  const trimmedFraction = fraction.replace(/0+$/, "");

  return {
    amountRtm: trimmedFraction ? `${whole}.${trimmedFraction}` : whole,
    amountAtomic: atomic.toString(),
  };
}

function getErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
}

async function readLinks(): Promise<Record<string, WalletLink>> {
  try {
    const data = JSON.parse(
      await readFile(path.join(dataDirectory, "telegram-links.json"), "utf8"),
    );

    if (!data.links || typeof data.links !== "object") {
      throw new Error("Invalid links file");
    }

    return data.links;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return {};
    throw error;
  }
}

async function withState<T>(action: (state: State) => Promise<T>): Promise<T> {
  return withDocument(statePath, () => ({ challenges: {}, payments: {} } as State), async (state: State) => {
    if (!state.challenges || !state.payments) throw new Error("Invalid payment storage");
    for (const [id, challenge] of Object.entries(state.challenges)) {
      if (challenge.expiresAt <= Date.now()) {
        delete state.challenges[id];
      }
    }

    state.listChallenges ??= {};
    state.listSessions ??= {};
    for (const [key, item] of Object.entries(state.listChallenges)) {
      if (item.expiresAt <= Date.now()) delete state.listChallenges[key];
    }
    for (const [key, item] of Object.entries(state.listSessions)) {
      if (item.expiresAt <= Date.now()) delete state.listSessions[key];
    }
    state.payChallenges ??= {};
    state.notices ??= {};
    for (const [key, challenge] of Object.entries(state.payChallenges)) {
      if (challenge.expiresAt <= Date.now()) delete state.payChallenges[key];
    }
    const result = await action(state);
    return result;
  });
}

function challengeStatement(challenge: {
  payment: Payment;
  splitPayments?: Payment[];
}) {
  if (!challenge.splitPayments) return requestStatement(challenge.payment);
  const rows = challenge.splitPayments;
  const hash = sha256(
    JSON.stringify(
      rows.map((p) => ({
        details: detailsHash(p),
        bill: p.splitBillId,
        total: p.splitTotalAtomic,
      })),
    ),
  );
  return `Retium Pay testnet Split Bill: ${rows.length} requests. Details SHA-256: ${hash}. No funds are transferred by this signature.`;
}

function publicPayment(payment: Payment) {
  return {
    id: payment.id,
    payerLabel: payment.payerLabel ?? "",
    payerTelegram: payment.payerTelegram,
    notifyTelegram: payment.notifyTelegram !== false,
    splitBillId: payment.splitBillId ?? null,
    splitTotalAtomic: payment.splitTotalAtomic ?? null,
    recipient: payment.recipient,
    payer: payment.payer,
    amountRtm: payment.amountRtm,
    description: payment.description,
    createdAt: payment.createdAt,
    status: payment.status,
    notification: payment.notification,
    amountAtomic: payment.amountAtomic,
    txId: payment.txId ?? payment.attempt?.txId ?? null,
    paidAt: payment.paidAt ?? null,
    paymentPhase:
      payment.status === "paid" ? "paid" : (payment.attempt?.phase ?? "unpaid"),
    paymentError: payment.attempt?.error ?? null,
  };
}

function readCookie(request: Request) {
  for (const entry of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = entry.trim().split("=");
    if (name === cookieName) return value.join("=");
  }

  return "";
}

// HTML is escaped before inserting any wallet or user-supplied description.
function telegramHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function telegramPaymentMessage(
  payment: Payment,
  chatId: string,
  paid: boolean,
) {
  const url = new URL(
    "/payments",
    process.env.APP_URL || "http://localhost:3000",
  );
  url.searchParams.set("id", payment.id);
  // Local development links remain text: Telegram URL buttons need a usable public address.
  const host = url.hostname.toLowerCase();
  const publicHttps =
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !["localhost", "[::1]"].includes(host) &&
    !host.endsWith(".localhost") &&
    !/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host);
  const code = (value: string) => `<code>${telegramHtml(value)}</code>`;
  const lines = [
    paid
      ? "✅ <b>Retium Pay · Payment confirmed</b>"
      : "💳 <b>Retium Pay · Payment request</b>",
    "",
    `<b>Amount:</b> ${telegramHtml(payment.amountRtm)} RTM`,
    `<b>Description:</b> ${telegramHtml(payment.description)}`,
    "",
    `<b>From:</b> ${code(payment.payer)}`,
    `<b>To:</b> ${code(payment.recipient)}`,
    "",
    `<b>Status:</b> ${paid ? "HardFinal ✅" : "Awaiting payment"}`,
  ];
  if (paid) {
    lines.push(
      "<b>Action:</b> RTM transfer",
      `<b>TX:</b> ${code(payment.txId || "Unavailable")}`,
    );
    if (payment.confirmedBlock)
      lines.push(`<b>Block:</b> ${code(payment.confirmedBlock)}`);
    if (payment.chainTimestamp) {
      const time = new Intl.DateTimeFormat("en-AU", {
        timeZone: "Australia/Sydney",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        timeZoneName: "short",
      }).format(new Date(payment.chainTimestamp * 1000));
      lines.push(`<b>Time (Australia/Sydney):</b> ${telegramHtml(time)}`);
    }
  }
  lines.push(
    "",
    `<b>Request ID:</b> ${code(payment.id)}`,
    "",
    "<i>Retium testnet · Test RTM only.</i>",
  );
  if (!paid) lines.push("Open the request and confirm in your wallet to pay.");
  if (!publicHttps)
    lines.push(
      "",
      `<b>Local test link:</b> ${telegramHtml(url.toString())}`,
      "Open this link on the computer running Retium Pay.",
    );
  return {
    chat_id: chatId,
    parse_mode: "HTML",
    text: lines.join("\n"),
    link_preview_options: { is_disabled: true },
    ...(publicHttps
      ? {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: paid
                    ? "📄 View payment"
                    : `💳 Pay ${payment.amountRtm} RTM`,
                  url: url.toString(),
                },
              ],
            ],
          },
        }
      : {}),
  };
}

async function notifyPayer(payment: Payment, chatId: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return false;

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(telegramPaymentMessage(payment, chatId, false)),
        signal: AbortSignal.timeout(10_000),
      },
    );

    const result = await response.json();
    return response.ok && result.ok === true;
  } catch {
    return false;
  }
}

export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams;
    if (query.get("action") === "directory")
      return await memberDirectory(request);
    if (query.get("action") === "dexJob") {
      try {
        return NextResponse.json(
          {
            job: await dexJob(
              query.get("tx") || "",
              await dexIdentity(request),
            ),
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      } catch (error) {
        throw new PaymentError(
          error instanceof Error ? error.message : "DEX status unavailable.",
        );
      }
    }
    if (query.get("action") === "list" || query.get("action") === "session") {
      return await getRequestList(request, query);
    }
    const id = query.get("id");

    if (!id || !/^[0-9a-f]{48}$/.test(id)) {
      throw new PaymentError("Invalid payment request ID.");
    }

    const result = await withState(async (state) => {
      const saved = state.payments[id];
      if (!saved) throw new PaymentError("Payment request not found.", 404);
      return {
        payment: publicPayment(saved),
        paidNotifications: paidDelivery(state, id),
      };
    });

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return failure(error);
  }
}

function failure(error: unknown) {
  const known = error instanceof PaymentError;

  return NextResponse.json(
    {
      error: known ? error.message : "Could not complete the payment request.",
    },
    {
      status: known ? error.status : 500,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export async function POST(request: Request) {
  try {
    if (request.headers.has("x-retium-worker-key"))
      return await handleWorkerTick(request);
    const origin = new URL(process.env.APP_URL || "http://localhost:3000")
      .origin;

    if (request.headers.get("origin") !== origin) {
      throw new PaymentError("Request origin is not allowed.", 403);
    }

    const rawBody = await request.text();

    if (rawBody.length > 20_000) {
      throw new PaymentError("Request is too large.", 413);
    }

    let body: Record<string, unknown>;

    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new PaymentError("Invalid JSON.");
    }

    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new PaymentError("Invalid JSON object.");
    if (body.operation === "dexCheck") {
      try {
        const wallet = await dexIdentity(request),
          txId = String(body.txId || "");
        await dexJob(txId, wallet); // Ownership must be checked before any RPC or notification work.
        // Let an online independent worker own RPC checks; browser polls its shared result.
        if (!(await workerStatus()).online) await dexTick({ txId, wallet });
        return NextResponse.json(
          { job: await dexJob(txId, wallet) },
          { headers: { "Cache-Control": "no-store" } },
        );
      } catch (error) {
        throw new PaymentError(
          error instanceof Error ? error.message : "Could not check DEX TX.",
        );
      }
    }
    if (body.operation === "dexRegister") {
      try {
        return NextResponse.json(
          {
            job: await dexRegister(
              String(body.ticket || ""),
              String(body.txId || ""),
              await dexIdentity(request),
            ),
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      } catch (error) {
        throw new PaymentError(
          error instanceof Error ? error.message : "Could not save DEX TX.",
        );
      }
    }
    if (
      ["prepareList", "verifyList", "logoutList"].includes(String(body.action))
    ) {
      return await handleListAuth(request, body, origin);
    }
    if (
      [
        "preparePay",
        "authorizePay",
        "attachTx",
        "checkPay",
        "cancelPay",
      ].includes(String(body.action))
    ) {
      return await handlePay(request, body, origin);
    }

    if (["saveContact", "removeContact"].includes(String(body.action)))
      return await memberDirectory(request, body);
    if (body.action === "prepareSplit") {
      const recipient = body.recipient;
      if (!validAddress(recipient))
        throw new PaymentError("Connect your receiving wallet first.");
      if (
        !Array.isArray(body.members) ||
        body.members.length < 2 ||
        body.members.length > 20
      )
        throw new PaymentError("Enter 2 to 20 payers.");
      const description =
        typeof body.description === "string" ? body.description.trim() : "";
      if (
        !description ||
        description.length > 140 ||
        /[\u0000-\u001f\u007f]/.test(description)
      )
        throw new PaymentError(
          "Enter a single-line bill description of 1 to 140 characters.",
        );
      const ownContacts = await withState(async (state) => {
        const session = listIdentity(state, request);
        return session?.address === recipient
          ? state.contacts?.[recipient] || []
          : [];
      });
      let telegramProfiles: Record<
        string,
        { displayName?: string; username?: string }
      > = {};
      try {
        telegramProfiles =
          JSON.parse(
            await readFile(
              path.join(dataDirectory, "telegram-state.json"),
              "utf8",
            ),
          ).profiles || {};
      } catch (e) {
        if (getErrorCode(e) !== "ENOENT")
          throw new PaymentError("Could not read Telegram names.");
      }
      const seen = new Set<string>();
      const billId = randomBytes(16).toString("hex");
      const payments: Payment[] = body.members.map((raw: unknown) => {
        if (!raw || typeof raw !== "object")
          throw new PaymentError("Invalid member.");
        const row = raw as Record<string, unknown>;
        if (
          !validAddress(row.payer) ||
          row.payer === recipient ||
          seen.has(String(row.payer))
        )
          throw new PaymentError(
            "Use distinct payer wallets, different from your receiving wallet.",
          );
        const label = typeof row.name === "string" ? row.name.trim() : "";
        if (label.length > 60 || /[\u0000-\u001f\u007f]/.test(label))
          throw new PaymentError("Enter a name of up to 60 characters.");
        if (
          row.notifyTelegram !== undefined &&
          typeof row.notifyTelegram !== "boolean"
        )
          throw new PaymentError("Invalid notification preference.");
        const payer = String(row.payer);
        seen.add(payer);
        const known =
          row.notifyTelegram !== false
            ? ownContacts.find((c) => c.address === payer && c.userId)
            : undefined;
        const profile = known ? telegramProfiles[known.userId] : undefined;
        const payerTelegram = profile
          ? {
              displayName: String(profile.displayName || "").slice(0, 120),
              username: String(profile.username || "").slice(0, 64),
            }
          : undefined;
        return {
          id: randomBytes(24).toString("hex"),
          recipient,
          payer,
          ...parseAmount(row.amount),
          description: `[Bill ${billId.slice(0, 8)}] ${description}`,
          createdAt: Date.now(),
          status: "requested",
          notification: "pending",
          proofHash: "",
          splitBillId: billId,
          payerLabel: label,
          ...(payerTelegram ? { payerTelegram } : {}),
          notifyTelegram: row.notifyTelegram !== false,
        };
      });
      const total = payments
        .reduce((sum, p) => sum + BigInt(p.amountAtomic), 0n)
        .toString();
      for (const payment of payments) payment.splitTotalAtomic = total;
      const cookie = randomBytes(32).toString("hex"),
        nonce = randomBytes(24).toString("hex");
      const challenge = {
        payment: payments[0],
        splitPayments: payments,
        nonce,
        expiresAt: Date.now() + 300_000,
        statement: "",
      };
      challenge.statement = challengeStatement(challenge);
      await withState(async (state) => {
        if (
          Object.keys(state.challenges).length >= 1000 ||
          Object.keys(state.payments).length + payments.length > 5000
        )
          throw new PaymentError("Local request limit reached.", 429);
        state.challenges[sha256(cookie)] = challenge;
      });
      const response = NextResponse.json({
        nonce,
        statement: challenge.statement,
        payments: payments.map(publicPayment),
        totalAtomic: total,
      });
      response.cookies.set(cookieName, cookie, {
        httpOnly: true,
        sameSite: "strict",
        secure: origin.startsWith("https:"),
        path: "/api/payments",
        maxAge: 300,
      });
      return response;
    }

    if (body.action === "prepare") {
      if (!validAddress(body.recipient) || !validAddress(body.payer)) {
        throw new PaymentError("Recipient or payer address is invalid.");
      }

      const recipient = body.recipient;
      const payer = body.payer;
      const amount = parseAmount(body.amount);
      const description =
        typeof body.description === "string" ? body.description.trim() : "";

      if (
        description.length < 1 ||
        description.length > 200 ||
        /[\u0000-\u001f\u007f]/.test(description)
      ) {
        throw new PaymentError(
          "Enter a single-line description of 1 to 200 characters.",
        );
      }

      const links = await readLinks();

      if (!links[recipient]) {
        throw new PaymentError("Link your receiving wallet to Telegram first.");
      }

      if (!links[payer]) {
        throw new PaymentError(
          "The payer must link their wallet to RetiumPay_Bot first.",
        );
      }

      const cookie = randomBytes(32).toString("hex");
      const nonce = randomBytes(24).toString("hex");
      const payment: Payment = {
        id: randomBytes(24).toString("hex"),
        recipient,
        payer,
        ...amount,
        description,
        createdAt: Date.now(),
        status: "requested",
        notification: "pending",
        proofHash: "",
      };

      const statement = requestStatement(payment);

      await withState(async (state) => {
        if (
          Object.keys(state.challenges).length >= 1000 ||
          Object.keys(state.payments).length >= 5000
        ) {
          throw new PaymentError("Local request limit reached.", 429);
        }

        state.challenges[sha256(cookie)] = {
          nonce,
          statement,
          payment,
          expiresAt: Date.now() + 5 * 60_000,
        };
      });

      const response = NextResponse.json(
        { nonce, statement },
        { headers: { "Cache-Control": "no-store" } },
      );

      response.cookies.set(cookieName, cookie, {
        httpOnly: true,
        sameSite: "strict",
        secure: origin.startsWith("https:"),
        path: "/api/payments",
        maxAge: 300,
      });

      return response;
    }

    if (body.action !== "create") {
      throw new PaymentError("Unknown action.");
    }

    const cookie = readCookie(request);

    if (!/^[0-9a-f]{64}$/.test(cookie)) {
      throw new PaymentError("Prepare the payment request again.");
    }

    if (
      typeof body.message !== "string" ||
      body.message.length > 8000 ||
      typeof body.address !== "string"
    ) {
      throw new PaymentError("Invalid signing response.");
    }

    const messageText = body.message;
    const publicKey = decodeHex(body.publicKey, 1312);
    const signature = decodeHex(body.signature, 2421);
    const address = deriveAddress(publicKey);

    if (signature[0] !== 2 || address !== body.address) {
      throw new PaymentError("Signature or wallet address is invalid.");
    }

    let message: Record<string, unknown>;

    try {
      message = JSON.parse(messageText);
    } catch {
      throw new PaymentError("Invalid authentication message.");
    }

    const proofHash = sha256(
      cookie + messageText + hex(signature) + hex(publicKey),
    );

    const result = await withState(async (state) => {
      const previous = Object.values(state.payments).find(
        (payment) => payment.proofHash === proofHash,
      );

      // A repeated submission returns the original request.
      if (previous)
        return {
          payment: previous,
          payments: Object.values(state.payments).filter(
            (p) => p.proofHash === proofHash,
          ),
          created: false,
        };

      const id = sha256(cookie);
      const challenge = state.challenges[id];

      if (!challenge || challenge.expiresAt <= Date.now()) {
        throw new PaymentError("Challenge expired. Prepare the request again.");
      }

      const issuedAt = message.issued_at;

      if (
        address !== challenge.payment.recipient ||
        message.v !== 1 ||
        message.purpose !== "retium-auth" ||
        message.chain_id !== 3 ||
        message.domain !== origin ||
        message.address !== address ||
        typeof message.public_key !== "string" ||
        hex(decodeHex(message.public_key, 1312)) !== hex(publicKey) ||
        message.nonce !== challenge.nonce ||
        message.statement !== challenge.statement ||
        challenge.statement !== challengeStatement(challenge) ||
        typeof issuedAt !== "number" ||
        !Number.isSafeInteger(issuedAt) ||
        issuedAt < Math.floor(challenge.payment.createdAt / 1000) - 30 ||
        issuedAt > Math.floor(Date.now() / 1000) + 30
      ) {
        throw new PaymentError(
          "The signed request does not match. Check the Wallet account.",
        );
      }

      const digest = blake3(encoder.encode(`RETIUM_AUTH_V1\n${messageText}`));

      if (!ml_dsa44.verify(signature.slice(1), digest, publicKey)) {
        throw new PaymentError("Signature verification failed.");
      }

      const links = await readLinks();

      if (
        !challenge.splitPayments &&
        (!links[address] || !links[challenge.payment.payer])
      ) {
        throw new PaymentError("A required Telegram link is missing.");
      }

      const payments = (challenge.splitPayments || [challenge.payment]).map(
        (p) => ({ ...p, proofHash }),
      );
      if (Object.keys(state.payments).length + payments.length > 5000)
        throw new PaymentError("Local request limit reached.", 429);
      for (const payment of payments) state.payments[payment.id] = payment;
      delete state.challenges[id];
      return { payment: payments[0], payments, created: true };
    });

    const payments = result.payments;
    if (result.created) {
      const links = await readLinks();
      for (let i = 0; i < payments.length; i++) {
        const payment = payments[i];
        const payerLink =
          payment.notifyTelegram === false ? undefined : links[payment.payer];
        let delivered = false;
        try {
          delivered = payerLink
            ? await notifyPayer(payment, payerLink.chatId)
            : false;
        } catch {
          /* Request remains saved when delivery fails. */
        }
        payments[i] = await withState(async (state) => {
          const saved = state.payments[payment.id];
          saved.notification =
            payment.notifyTelegram === false
              ? "disabled"
              : !payerLink
                ? "unlinked"
                : delivered
                  ? "sent"
                  : "failed";
          return saved;
        });
      }
    }
    return NextResponse.json(
      {
        payment: publicPayment(payments[0]),
        payments: payments.map(publicPayment),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}

function payCookie(id: string) {
  return `retium_pay_${id}`;
}
function getNamedCookie(request: Request, name: string) {
  return (
    (request.headers.get("cookie") ?? "")
      .split(";")
      .map((entry) => entry.trim().split("="))
      .find(([key]) => key === name)
      ?.slice(1)
      .join("=") ?? ""
  );
}
function paymentFrom(state: State, id: string) {
  const payment = state.payments[id];
  if (!payment) throw new PaymentError("Payment request not found.", 404);
  return payment;
}
function authorizedAttempt(payment: Payment, cookie: string) {
  if (
    !/^[0-9a-f]{64}$/.test(cookie) ||
    !payment.attempt ||
    payment.attempt.sessionHash !== sha256(cookie)
  ) {
    throw new PaymentError(
      "Verify the payer wallet again to check this payment.",
      401,
    );
  }
  return payment.attempt;
}
async function rpcRead(endpoint: string) {
  const base = process.env.RETIUM_RPC_URL || "https://rpc.retium.org";
  const url = new URL(endpoint, base);
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new PaymentError(
      "RPC unavailable. Payment is not confirmed. Do not send again; check later.",
      503,
    );
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    const retry = response.headers.get("retry-after");
    const wait =
      retry && /^\d+$/.test(retry)
        ? Number(retry) * 1000
        : retry
          ? Date.parse(retry) - Date.now()
          : 15_000;
    throw new PaymentError(
      "RPC is busy. Check again later; do not send again.",
      503,
      Math.min(
        300_000,
        Math.max(15_000, Number.isFinite(wait) ? wait : 15_000),
      ),
    );
  }
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PaymentError(
      "Invalid RPC response. No payment was confirmed.",
      502,
    );
  }
  return value as Record<string, unknown>;
}

async function handlePay(
  request: Request,
  body: Record<string, unknown>,
  origin: string,
) {
  const id = body.id;
  if (typeof id !== "string" || !/^[0-9a-f]{48}$/.test(id)) {
    throw new PaymentError("Invalid payment request ID.");
  }
  const cookie = getNamedCookie(request, payCookie(id));

  if (body.action === "preparePay") {
    const snapshot = await withState(async (state) => paymentFrom(state, id));
    if (snapshot.status === "paid")
      throw new PaymentError("This request is already paid.", 409);
    if (snapshot.recipient === snapshot.payer) {
      throw new PaymentError(
        "Use two different wallets for payment. This self-request can only test notifications.",
      );
    }
    let expectedNonce = snapshot.attempt?.expectedNonce;
    if (expectedNonce === undefined) {
      const wallet = await rpcRead(`/api/wallet/${snapshot.payer}`);
      if (
        !wallet ||
        typeof wallet.nonce !== "number" ||
        !Number.isSafeInteger(wallet.nonce) ||
        wallet.nonce < 0
      ) {
        throw new PaymentError(
          "The RPC did not return a valid payer nonce.",
          502,
        );
      }
      expectedNonce = wallet.nonce;
    }
    const nonce = randomBytes(24).toString("hex");
    const secret = randomBytes(32).toString("hex");
    const statement = authorizeStatement(snapshot, expectedNonce);
    await withState(async (state) => {
      const payment = paymentFrom(state, id);
      if (payment.status === "paid")
        throw new PaymentError("Already paid.", 409);
      if (detailsHash(payment) !== detailsHash(snapshot))
        throw new PaymentError("Request changed. Reload.", 409);
      if (Object.keys(state.payChallenges!).length >= 1000)
        throw new PaymentError("Too many signing challenges.", 429);
      state.payChallenges![sha256(secret)] = {
        id,
        nonce,
        statement,
        expectedNonce: expectedNonce!,
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
        detailsHash: detailsHash(payment),
      };
    });
    const response = NextResponse.json({
      nonce,
      statement,
      recovery: !!snapshot.attempt,
    });
    response.cookies.set(payCookie(id), secret, {
      httpOnly: true,
      sameSite: "strict",
      secure: origin.startsWith("https:"),
      path: "/api/payments",
      maxAge: 86400,
    });
    return response;
  }

  if (body.action === "authorizePay") {
    if (
      !/^[0-9a-f]{64}$/.test(cookie) ||
      typeof body.message !== "string" ||
      body.message.length > 8000
    ) {
      throw new PaymentError("Prepare payment verification again.");
    }
    const messageText = body.message;
    const publicKey = decodeHex(body.publicKey, 1312);
    const signature = decodeHex(body.signature, 2421);
    const address = deriveAddress(publicKey);
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(messageText);
    } catch {
      throw new PaymentError("Invalid signature message.");
    }
    if (!message || typeof message !== "object" || Array.isArray(message))
      throw new PaymentError("Invalid signature message.");
    const result = await withState(async (state) => {
      const challenge = state.payChallenges![sha256(cookie)];
      const payment = paymentFrom(state, id);
      if (
        !challenge ||
        challenge.id !== id ||
        challenge.expiresAt <= Date.now()
      )
        throw new PaymentError("Verification expired. Prepare again.");
      if (payment.status === "paid")
        throw new PaymentError("Already paid.", 409);
      const issuedAt = message.issued_at;
      if (
        signature[0] !== 2 ||
        body.address !== address ||
        address !== payment.payer ||
        message.v !== 1 ||
        message.purpose !== "retium-auth" ||
        message.chain_id !== 3 ||
        message.address !== address ||
        message.domain !== origin ||
        message.nonce !== challenge.nonce ||
        message.statement !== challenge.statement ||
        challenge.statement !==
          authorizeStatement(payment, challenge.expectedNonce) ||
        challenge.detailsHash !== detailsHash(payment) ||
        typeof message.public_key !== "string" ||
        hex(decodeHex(message.public_key, 1312)) !== hex(publicKey) ||
        typeof issuedAt !== "number" ||
        !Number.isSafeInteger(issuedAt) ||
        issuedAt < Math.floor(challenge.createdAt / 1000) - 30 ||
        issuedAt > Math.floor(Date.now() / 1000) + 30 ||
        !ml_dsa44.verify(
          signature.slice(1),
          blake3(encoder.encode(`RETIUM_AUTH_V1\n${messageText}`)),
          publicKey,
        )
      ) {
        throw new PaymentError(
          "Payer signature verification failed. Check the selected Wallet.",
        );
      }
      const readyToSend = !payment.attempt;
      if (payment.attempt) {
        // Re-authentication restores checking only. It never enables another send.
        payment.attempt.sessionHash = sha256(cookie);
      } else {
        payment.attempt = {
          sessionHash: sha256(cookie),
          authorizedAt: Date.now(),
          expectedNonce: challenge.expectedNonce,
          phase: "reserved",
        };
      }
      delete state.payChallenges![sha256(cookie)];
      return { payment: publicPayment(payment), readyToSend };
    });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  }

  if (body.action === "cancelPay") {
    // Called only after Wallet explicitly reports 4001 or 4300, never on timeout.
    const result = await withState(async (state) => {
      const payment = paymentFrom(state, id);
      const attempt = authorizedAttempt(payment, cookie);
      if (attempt.txId || payment.status === "paid")
        throw new PaymentError("An existing TX must be checked first.", 409);
      delete payment.attempt;
      payment.status = "requested";
      return publicPayment(payment);
    });
    return NextResponse.json({ payment: result });
  }

  const snapshot = await withState(async (state) => {
    const payment = paymentFrom(state, id);
    const attempt = authorizedAttempt(payment, cookie);
    if (body.action === "attachTx") {
      if (typeof body.txId !== "string" || !/^tx_[0-9a-f]{32}$/.test(body.txId))
        throw new PaymentError("Invalid TX ID.");
      if (attempt.txId && attempt.txId !== body.txId)
        throw new PaymentError(
          "Another TX is already attached. Check it first.",
          409,
        );
      if (
        Object.values(state.payments).some(
          (other) =>
            other.id !== id &&
            (other.txId === body.txId || other.attempt?.txId === body.txId),
        )
      ) {
        throw new PaymentError(
          "This TX is already assigned to another request.",
          409,
        );
      }
      if (payment.status !== "paid" && !attempt.txId) {
        attempt.txId = body.txId;
        attempt.phase = "submitted";
        payment.status = "processing";
      }
    }
    return structuredClone(payment);
  });

  if (body.action === "attachTx") {
    return NextResponse.json(
      {
        payment: publicPayment(snapshot),
        queued: snapshot.status !== "paid",
        paidNotifications: await withState(async (state) =>
          paidDelivery(state, id),
        ),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  await settleSnapshot(snapshot);
  await deliverPaidNotices(id);
  const result = await withState(async (state) => ({
    payment: publicPayment(paymentFrom(state, id)),
    paidNotifications: Object.values(state.notices!)
      .filter((n) => n.paymentId === id)
      .map((n) => n.state),
  }));
  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}

async function deliverPaidNotices(id: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return;
  for (let index = 0; index < 2; index++) {
    const job = await withState(async (state) => {
      // An interrupted send has an unknown delivery result; don't duplicate it automatically.
      for (const notice of Object.values(state.notices!)) {
        if (
          notice.state === "sending" &&
          (notice.claimedAt ?? 0) < Date.now() - 60_000
        )
          notice.state = "unknown";
      }
      const entry = Object.entries(state.notices!).find(
        ([, n]) => n.paymentId === id && n.state === "pending",
      );
      if (!entry) return null;
      const [key, notice] = entry;
      notice.state = "sending";
      notice.claimedAt = Date.now();
      return {
        key,
        chatId: notice.chatId,
        payment: structuredClone(paymentFrom(state, id)),
      };
    });
    if (!job) return;
    let delivery: Notice["state"] = "unknown";
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            telegramPaymentMessage(job.payment, job.chatId, true),
          ),
          signal: AbortSignal.timeout(10_000),
        },
      );
      const result = await response.json();
      delivery = response.ok && result.ok === true ? "sent" : "failed";
    } catch {
      /* Network interruption can mean delivered without an acknowledgement. */
    }
    await withState(async (state) => {
      state.notices![job.key].state = delivery;
    });
  }
}

const listChallengeCookie = "retium_requests_challenge";
const listSessionCookie = "retium_requests_session";
const listStatement =
  "View my Retium Pay requests for this wallet. This signature does not authorize payments or transfer funds.";
function paidDelivery(state: State, id: string) {
  return Object.values(state.notices ?? {})
    .filter((notice) => notice.paymentId === id)
    .map((notice) => notice.state);
}
function listCookieOptions(origin: string, seconds: number) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: origin.startsWith("https:"),
    path: "/api/payments",
    maxAge: seconds,
  };
}
function listIdentity(state: State, request: Request) {
  const token = getNamedCookie(request, listSessionCookie);
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const session = state.listSessions![sha256(token)];
  return session && session.expiresAt > Date.now() ? session : null;
}
async function handleListAuth(
  request: Request,
  body: Record<string, unknown>,
  origin: string,
) {
  if (body.action === "logoutList") {
    await withState(async (state) => {
      delete state.listSessions![
        sha256(getNamedCookie(request, listSessionCookie))
      ];
      delete state.listChallenges![
        sha256(getNamedCookie(request, listChallengeCookie))
      ];
    });
    const response = NextResponse.json(
      { signedOut: true },
      { headers: { "Cache-Control": "no-store" } },
    );
    response.cookies.set(listSessionCookie, "", listCookieOptions(origin, 0));
    response.cookies.set(listChallengeCookie, "", listCookieOptions(origin, 0));
    return response;
  }
  if (body.action === "prepareList") {
    if (!validAddress(body.address))
      throw new PaymentError("Connect a valid Retium wallet first.");
    const address = body.address;
    const cookie = randomBytes(32).toString("hex");
    const nonce = randomBytes(24).toString("hex");
    await withState(async (state) => {
      if (Object.keys(state.listChallenges!).length >= 1000)
        throw new PaymentError("Too many login challenges. Try later.", 429);
      const previous = getNamedCookie(request, listChallengeCookie);
      if (previous) delete state.listChallenges![sha256(previous)];
      state.listChallenges![sha256(cookie)] = {
        address,
        nonce,
        statement: listStatement,
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
      };
    });
    const response = NextResponse.json(
      { nonce, statement: listStatement },
      { headers: { "Cache-Control": "no-store" } },
    );
    response.cookies.set(
      listChallengeCookie,
      cookie,
      listCookieOptions(origin, 300),
    );
    return response;
  }
  const cookie = getNamedCookie(request, listChallengeCookie);
  if (
    !/^[0-9a-f]{64}$/.test(cookie) ||
    typeof body.message !== "string" ||
    body.message.length > 8000
  )
    throw new PaymentError("Prepare wallet verification again.");
  const publicKey = decodeHex(body.publicKey, 1312);
  const signature = decodeHex(body.signature, 2421);
  const address = deriveAddress(publicKey);
  const messageText = body.message;
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(messageText);
  } catch {
    throw new PaymentError("Invalid authentication message.");
  }
  if (!message || typeof message !== "object" || Array.isArray(message))
    throw new PaymentError("Invalid authentication message.");
  const sessionToken = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + 3_600_000;
  await withState(async (state) => {
    const challenge = state.listChallenges![sha256(cookie)];
    if (!challenge || challenge.expiresAt <= Date.now())
      throw new PaymentError("Verification expired. Prepare again.");
    const issuedAt = message.issued_at;
    if (
      signature[0] !== 2 ||
      body.address !== address ||
      address !== challenge.address ||
      message.v !== 1 ||
      message.purpose !== "retium-auth" ||
      message.chain_id !== 3 ||
      message.address !== address ||
      message.domain !== origin ||
      message.nonce !== challenge.nonce ||
      message.statement !== challenge.statement ||
      challenge.statement !== listStatement ||
      typeof message.public_key !== "string" ||
      hex(decodeHex(message.public_key, 1312)) !== hex(publicKey) ||
      typeof issuedAt !== "number" ||
      !Number.isSafeInteger(issuedAt) ||
      issuedAt < Math.floor(challenge.createdAt / 1000) - 30 ||
      issuedAt > Math.floor(Date.now() / 1000) + 30 ||
      !ml_dsa44.verify(
        signature.slice(1),
        blake3(encoder.encode(`RETIUM_AUTH_V1\n${messageText}`)),
        publicKey,
      )
    ) {
      throw new PaymentError(
        "Wallet verification failed. Use the connected account.",
      );
    }
    if (Object.keys(state.listSessions!).length >= 1000)
      throw new PaymentError("Too many active sessions. Try later.", 429);
    delete state.listSessions![
      sha256(getNamedCookie(request, listSessionCookie))
    ];
    delete state.listChallenges![sha256(cookie)];
    state.listSessions![sha256(sessionToken)] = { address, expiresAt };
  });
  const response = NextResponse.json(
    { address, expiresAt },
    { headers: { "Cache-Control": "no-store" } },
  );
  response.cookies.set(
    listSessionCookie,
    sessionToken,
    listCookieOptions(origin, 3600),
  );
  response.cookies.set(listChallengeCookie, "", listCookieOptions(origin, 0));
  return response;
}
async function memberDirectory(
  request: Request,
  body?: Record<string, unknown>,
) {
  const telegramPath = path.join(dataDirectory, "telegram-state.json");
  let telegram: {
    profiles?: Record<string, { displayName?: string; username?: string }>;
    sharedContacts?: Record<
      string,
      { userId: string; address: string; updatedAt: number }
    >;
    contactCodes?: Record<
      string,
      { userId: string; address: string; expiresAt: number }
    >;
  } = {};
  try {
    telegram = JSON.parse(await readFile(telegramPath, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      throw new PaymentError("Member directory unavailable.");
  }
  const links = await readLinks();
  const result = await withState(async (state) => {
    const session = listIdentity(state, request);
    if (!session)
      throw new PaymentError("Verify your wallet to view your requests.", 401);
    const owner = session.address;
    state.contacts ??= {};
    const contacts = state.contacts[owner] || [];
    if (body?.action === "saveContact") {
      const nickname =
        typeof body.nickname === "string" ? body.nickname.trim() : "";
      if (
        !nickname ||
        nickname.length > 60 ||
        /[\u0000-\u001f\u007f]/.test(nickname)
      )
        throw new PaymentError("Enter a nickname of 1 to 60 characters.");
      if (body.registeredUserId !== undefined) {
        const userId = String(body.registeredUserId);
        if (!/^[1-9][0-9]{0,19}$/.test(userId))
          throw new PaymentError("Invalid registered member.");
        const registered = telegram.sharedContacts?.[userId];
        if (
          !registered ||
          registered.userId !== userId ||
          links[registered.address]?.userId !== userId
        )
          throw new PaymentError(
            "This member is no longer available. Refresh members.",
          );
        if (registered.address === owner)
          throw new PaymentError("Your receiving wallet cannot be a payer.");
        let existing = contacts.find(
          (c) => c.userId === userId || c.address === registered.address,
        );
        if (!existing) {
          if (contacts.length >= 200)
            throw new PaymentError("Member limit reached.");
          existing = {
            address: registered.address,
            userId,
            nickname,
            addedAt: Date.now(),
          };
          contacts.push(existing);
        }
        existing.address = registered.address;
        existing.userId = userId;
        existing.nickname = nickname;
      }
      const code = typeof body.code === "string" ? body.code.trim() : "";
      let member = contacts.find((c) =>
        body.registeredUserId
          ? c.userId === String(body.registeredUserId)
          : c.address === body.memberAddress,
      );
      if (code) {
        if (!/^RP-[0-9a-f]{32}$/.test(code))
          throw new PaymentError(
            "Invalid member code. Ask the member for /contact.",
          );
        const consent = telegram.contactCodes?.[code];
        if (
          !consent ||
          consent.expiresAt <= Date.now() ||
          links[consent.address]?.userId !== consent.userId
        )
          throw new PaymentError(
            "Member code expired or wallet link changed. Ask for /contact again.",
          );
        if (consent.address === owner)
          throw new PaymentError("Your receiving wallet cannot be a payer.");
        member = contacts.find((c) => c.address === consent.address);
        if (!member) {
          if (contacts.length >= 200)
            throw new PaymentError("Member limit reached.");
          member = {
            address: consent.address,
            userId: consent.userId,
            nickname,
            addedAt: Date.now(),
          };
          contacts.push(member);
        }
      }
      if (!code && !member) {
        const wallet =
          typeof body.wallet === "string"
            ? body.wallet.trim().toLowerCase()
            : "";
        if (!validAddress(wallet) || wallet === owner)
          throw new PaymentError(
            "Enter a valid payer wallet, different from your receiving wallet.",
          );
        member = contacts.find((c) => c.address === wallet);
        if (!member) {
          if (contacts.length >= 200)
            throw new PaymentError("Member limit reached.");
          member = {
            address: wallet,
            userId: "",
            nickname,
            addedAt: Date.now(),
          };
          contacts.push(member);
        }
      }
      if (!member)
        throw new PaymentError("Enter a wallet address or member code.");
      if (code) member.userId = telegram.contactCodes![code].userId;
      member.nickname = nickname;
    }
    if (body?.action === "removeContact") {
      state.contacts[owner] = contacts.filter(
        (c) => c.address !== body.memberAddress,
      );
    } else state.contacts[owner] = contacts;
    return {
      address: owner,
      registered: Object.values(telegram.sharedContacts || {})
        .filter(
          (c) =>
            c.address !== owner &&
            c.userId &&
            links[c.address]?.userId === c.userId,
        )
        .map((c) => ({
          userId: c.userId,
          address: c.address,
          displayName: telegram.profiles?.[c.userId]?.displayName || "",
          username: telegram.profiles?.[c.userId]?.username || "",
        })),
      members: (state.contacts[owner] || []).map((c) => ({
        address: c.address,
        nickname: c.nickname,
        displayName: telegram.profiles?.[c.userId]?.displayName || "",
        username: telegram.profiles?.[c.userId]?.username || "",
        linked: !!links[c.address],
      })),
    };
  });
  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store", Vary: "Cookie" },
  });
}

async function getRequestList(request: Request, query: URLSearchParams) {
  const result = await withState(async (state) => {
    const session = listIdentity(state, request);
    if (query.get("action") === "session")
      return {
        address: session?.address ?? null,
        expiresAt: session?.expiresAt ?? null,
      };
    if (!session)
      throw new PaymentError("Verify your wallet to view your requests.", 401);
    const address = session.address;
    const role = query.get("role") ?? "all";
    const status = query.get("status") ?? "all";
    const rawPage = query.get("page") ?? "1";
    if (
      !["all", "created", "payable"].includes(role) ||
      !["all", "requested", "processing", "paid", "review"].includes(status) ||
      !/^[1-9]\d{0,5}$/.test(rawPage)
    )
      throw new PaymentError("Invalid list filters.");
    // The cookie-derived address is the only identity accepted here.
    const owned = Object.values(state.payments).filter(
      (p) => p.recipient === address || p.payer === address,
    );
    const summary = {
      total: owned.length,
      created: owned.filter((p) => p.recipient === address).length,
      payable: owned.filter((p) => p.payer === address).length,
      paid: owned.filter((p) => p.status === "paid").length,
      unpaid: owned.filter((p) => p.status !== "paid").length,
      review: owned.filter(
        (p) => p.status !== "paid" && p.attempt?.phase === "unknown",
      ).length,
    };
    const groups = new Map<string, Payment[]>();
    for (const payment of owned) {
      if (payment.recipient !== address || !payment.splitBillId) continue;
      const rows = groups.get(payment.splitBillId) || [];
      rows.push(payment);
      groups.set(payment.splitBillId, rows);
    }
    const splitBills = [...groups.entries()]
      .map(([id, members]) => ({
        id,
        description: members[0].description,
        createdAt: members[0].createdAt,
        totalAtomic: members
          .reduce((n, p) => n + BigInt(p.amountAtomic), 0n)
          .toString(),
        paidAtomic: members
          .reduce(
            (n, p) => n + (p.status === "paid" ? BigInt(p.amountAtomic) : 0n),
            0n,
          )
          .toString(),
        paid: members.filter((p) => p.status === "paid").length,
        count: members.length,
        members: members.map((p) => ({
          id: p.id,
          payer: p.payer,
          payerLabel: p.payerLabel || "",
          payerTelegram: p.payerTelegram,
          amountRtm: p.amountRtm,
          status: p.status,
        })),
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
    const rows = owned
      .filter(
        (p) =>
          (role === "all" ||
            (role === "created"
              ? p.recipient === address
              : p.payer === address)) &&
          (status === "all" ||
            (status === "review"
              ? p.status !== "paid" && p.attempt?.phase === "unknown"
              : p.status === status)),
      )
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    const pageSize = 20;
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    const page = Math.min(Number(rawPage), pages);
    return {
      address,
      expiresAt: session.expiresAt,
      summary,
      splitBills,
      total: rows.length,
      page,
      pageSize,
      pages,
      requests: rows.slice((page - 1) * pageSize, page * pageSize).map((p) => ({
        ...publicPayment(p),
        paidNotifications: paidDelivery(state, p.id),
      })),
    };
  });
  return NextResponse.json(
    query.get("action") === "list"
      ? { ...result, worker: await workerStatus() }
      : result,
    { headers: { "Cache-Control": "no-store", Vary: "Cookie" } },
  );
}

async function settleSnapshot(snapshot: Payment) {
  const id = snapshot.id;
  if (snapshot.status !== "paid" && snapshot.attempt?.txId) {
    const txId = snapshot.attempt.txId;
    const tx = await rpcRead(`/api/transaction/${txId}`);
    if (tx) {
      let final = false;
      let validationError = "";
      try {
        final = validateTransfer(
          tx,
          snapshot,
          snapshot.attempt.expectedNonce,
          txId,
        );
      } catch (error) {
        validationError =
          error instanceof Error ? error.message : "TX verification failed.";
      }
      const links = final ? await readLinks() : {};
      await withState(async (state) => {
        const payment = paymentFrom(state, id);
        if (payment.status === "paid") return;
        const attempt = payment.attempt;
        if (
          !attempt ||
          attempt.txId !== txId ||
          attempt.expectedNonce !== snapshot.attempt!.expectedNonce ||
          detailsHash(payment) !== detailsHash(snapshot)
        )
          throw new PaymentError("Payment state changed. Check again.", 409);
        if (validationError) {
          attempt.phase = "unknown";
          attempt.error = validationError;
          return;
        }
        if (!final) return;
        if (
          Object.values(state.payments).some(
            (other) => other.id !== id && other.txId === txId,
          )
        )
          throw new PaymentError("TX already used.", 409);
        payment.status = "paid";
        payment.paidAt = Date.now();
        payment.txId = txId;
        const block = tx.block_id;
        if (typeof block === "string" && /^[0-9]{1,40}$/.test(block))
          payment.confirmedBlock = block;
        else if (
          typeof block === "number" &&
          Number.isSafeInteger(block) &&
          block >= 0
        )
          payment.confirmedBlock = String(block);
        if (
          typeof tx.timestamp === "number" &&
          Number.isSafeInteger(tx.timestamp)
        )
          payment.chainTimestamp = tx.timestamp;
        delete attempt.error;
        // Deduplicate the chat if both linked wallets belong to the same account.
        const chats = new Set(
          [
            payment.notifyTelegram === false
              ? undefined
              : links[payment.payer]?.chatId,
            links[payment.recipient]?.chatId,
          ].filter((chat): chat is string => !!chat),
        );
        for (const chatId of chats) {
          const key = sha256(`${id}:${chatId}:paid`);
          state.notices![key] ??= { paymentId: id, chatId, state: "pending" };
        }
      });
    }
  }
}

async function workerStatus() {
  try {
    const raw = JSON.parse(
      await readFile(
        path.join(dataDirectory, "payments-worker-status.json"),
        "utf8",
      ),
    );
    const lastSeenAt = typeof raw.lastSeenAt === "number" ? raw.lastSeenAt : 0;
    return {
      online: raw.running === true && Date.now() - lastSeenAt < 90_000,
      lastSeenAt,
      lastSuccessAt:
        typeof raw.lastSuccessAt === "number" ? raw.lastSuccessAt : null,
    };
  } catch {
    return { online: false, lastSeenAt: null, lastSuccessAt: null };
  }
}

async function handleWorkerTick(request: Request) {
  const supplied = request.headers.get("x-retium-worker-key") ?? "";
  if (!/^[0-9a-f]{64}$/.test(supplied))
    throw new PaymentError("Worker authentication failed.", 401);
  let secret: string;
  try {
    secret = (
      await readFile(path.join(dataDirectory, "payments-worker.key"), "utf8")
    ).trim();
  } catch {
    throw new PaymentError("Start the local payments worker first.", 503);
  }
  if (
    !/^[0-9a-f]{64}$/.test(secret) ||
    !timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(secret, "hex"))
  ) {
    throw new PaymentError("Worker authentication failed.", 401);
  }
  const rawBody = await request.text();
  if (rawBody.length > 1000)
    throw new PaymentError("Worker request too large.", 413);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new PaymentError("Invalid worker request.");
  }
  if (!body || body.action !== "workerTick")
    throw new PaymentError("Invalid worker action.");

  const snapshot = await withState(async (state) => {
    const due = Object.values(state.payments)
      .filter(
        (p) =>
          p.status !== "paid" &&
          p.attempt?.txId &&
          p.attempt.phase !== "unknown" &&
          (p.monitor?.nextCheckAt ?? 0) <= Date.now(),
      )
      .sort(
        (a, b) =>
          (a.monitor?.lastCheckedAt ?? 0) - (b.monitor?.lastCheckedAt ?? 0) ||
          a.createdAt - b.createdAt,
      );
    const payment = due[0];
    if (!payment) return null;
    payment.monitor = {
      ...payment.monitor,
      failures: payment.monitor?.failures ?? 0,
      lastCheckedAt: Date.now(),
      nextCheckAt: Date.now() + 60_000,
    };
    return structuredClone(payment);
  });
  let retryAfterMs = 0;
  let rpcError = false;
  if (snapshot) {
    try {
      await settleSnapshot(snapshot);
      await withState(async (state) => {
        const p = paymentFrom(state, snapshot.id);
        p.monitor = {
          lastCheckedAt: Date.now(),
          nextCheckAt: Date.now() + 15_000,
          failures: 0,
        };
      });
    } catch (error) {
      rpcError = true;
      await withState(async (state) => {
        const p = paymentFrom(state, snapshot.id);
        const failures = (p.monitor?.failures ?? 0) + 1;
        retryAfterMs = Math.max(
          error instanceof PaymentError ? error.retryAfterMs : 15_000,
          Math.min(300_000, 15_000 * 2 ** Math.min(failures - 1, 5)),
        );
        p.monitor = {
          lastCheckedAt: Date.now(),
          nextCheckAt: Date.now() + retryAfterMs,
          failures,
          lastError: "RPC check unavailable; payment not confirmed.",
        };
      });
    }
  }
  // Pending messages survive a restart. Browser and worker claim the same queue under one lock.
  const notificationId = await withState(async (state) => {
    for (const notice of Object.values(state.notices!)) {
      if (
        notice.state === "sending" &&
        (notice.claimedAt ?? 0) < Date.now() - 60_000
      )
        notice.state = "unknown";
    }
    return (
      Object.values(state.notices!).find((n) => n.state === "pending")
        ?.paymentId ?? null
    );
  });
  if (notificationId) await deliverPaidNotices(notificationId);
  const dexChecked = !snapshot && !notificationId ? await dexTick() : false;
  const counts = await withState(async (state) => ({
    pending: Object.values(state.payments).filter(
      (p) =>
        p.status !== "paid" && p.attempt?.txId && p.attempt.phase !== "unknown",
    ).length,
    needsReview: Object.values(state.payments).filter(
      (p) => p.status !== "paid" && p.attempt?.phase === "unknown",
    ).length,
    pendingNotices: Object.values(state.notices!).filter(
      (n) => n.state === "pending",
    ).length,
  }));
  return NextResponse.json(
    {
      ok: true,
      checked: snapshot || dexChecked ? 1 : 0,
      rpcError,
      retryAfterMs,
      ...counts,
      ...await dexQueueSummary(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export const maxDuration = 60;
