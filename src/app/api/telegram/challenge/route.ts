import { createHash, randomBytes } from "node:crypto";
import { readData as readFile, withDocument } from "../../../../lib/storage/store.mjs";
import path from "node:path";
import { NextResponse } from "next/server";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { blake3 } from "@noble/hashes/blake3.js";

type Registration = {
  userId: string;
  chatId: string;
  code: string;
  expiresAt: number;
};

type Challenge = {
  nonce: string;
  statement: string;
  codeHash: string;
  userId: string;
  chatId: string;
  createdAt: number;
  expiresAt: number;
};

type WalletLink = {
  address: string;
  userId: string;
  chatId: string;
  linkedAt: number;
};

type AuthState = {
  challenges: Record<string, Challenge>;
  usedCodes: Record<string, number>;
  links: Record<string, WalletLink>;
};

class RequestError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const directory = path.join(process.cwd(), "data");
const statePath = path.join(directory, "telegram-links.json");
const cookieName = "retium_telegram_challenge";
const encoder = new TextEncoder();

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function hex(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("hex");
}

function parseHex(value: unknown, bytes: number) {
  if (typeof value !== "string") {
    throw new RequestError("Invalid signing response.");
  }

  const normalized = value.replace(/^0x/i, "");

  if (
    normalized.length !== bytes * 2 ||
    !/^[0-9a-f]+$/i.test(normalized)
  ) {
    throw new RequestError("Invalid key or signature format.");
  }

  return Uint8Array.from(Buffer.from(normalized, "hex"));
}

function deriveAddress(publicKey: Uint8Array) {
  const addressHash = blake3(publicKey);
  const checksumInput = new Uint8Array([
    ...encoder.encode("retium.addr.v1"),
    ...addressHash,
  ]);
  const checksum = blake3(checksumInput).slice(0, 2);

  return `rete${hex(addressHash)}${hex(checksum)}`;
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
}

async function withState<T>(
  action: (state: AuthState) => Promise<T>,
): Promise<T> {
  return withDocument(statePath, () => ({ challenges: {}, usedCodes: {}, links: {} } as AuthState), async (state: AuthState) => {
    if (!state.challenges || !state.usedCodes || !state.links) throw new Error("Invalid link storage");
    const now = Date.now();

    for (const [id, challenge] of Object.entries(state.challenges)) {
      if (challenge.expiresAt <= now) delete state.challenges[id];
    }

    const result = await action(state);
    return result;
  });
}

async function findRegistration(code: string): Promise<Registration> {
  let data: { registrations?: Record<string, Registration> };

  try {
    data = JSON.parse(
      await readFile(path.join(directory, "telegram-state.json"), "utf8"),
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new RequestError("Open the Telegram bot and use /register first.");
    }
    throw error;
  }

  const registration = Object.values(data.registrations ?? {}).find(
    (item) =>
      item.code === code &&
      Number.isFinite(item.expiresAt) &&
      item.expiresAt > Date.now() &&
      /^\d+$/.test(item.userId) &&
      /^\d+$/.test(item.chatId),
  );

  if (!registration) {
    throw new RequestError(
      "Registration code is invalid or expired. Request a code from the bot.",
    );
  }

  return registration;
}

function readChallengeCookie(request: Request) {
  const cookies = request.headers.get("cookie") ?? "";

  for (const entry of cookies.split(";")) {
    const [name, ...value] = entry.trim().split("=");
    if (name === cookieName) return value.join("=");
  }

  return "";
}

async function notifyLinked(link: WalletLink) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return false;

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: link.chatId,
          text: [
            "Retium Pay",
            "",
            "Your Telegram account is now linked to:",
            link.address,
            "",
            "Wallet ownership was verified by signature.",
            "No payment was made.",
          ].join("\n"),
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );

    const data = await response.json();
    return response.ok && data.ok === true;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  try {
    const origin = new URL(
      process.env.APP_URL || "http://localhost:3000",
    ).origin;

    if (request.headers.get("origin") !== origin) {
      throw new RequestError("Request origin is not allowed.", 403);
    }

    const rawBody = await request.text();

    if (rawBody.length > 20_000) {
      throw new RequestError("Request is too large.", 413);
    }

    let body: Record<string, unknown>;

    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new RequestError("Invalid JSON.");
    }

    if (body.action === "challenge") {
      const code =
        typeof body.code === "string" ? body.code.trim().toLowerCase() : "";

      if (!/^[0-9a-f]{32}$/.test(code)) {
        throw new RequestError("Enter the registration code from Telegram.");
      }

      const registration = await findRegistration(code);
      const codeHash = hash(code);
      const cookie = randomBytes(32).toString("hex");
      const nonce = randomBytes(24).toString("hex");
      const statement =
        `Link this Retium wallet to my Retium Pay Telegram registration ${codeHash}. ` +
        "This does not authorize payments.";
      const now = Date.now();

      await withState(async (state) => {
        if (state.usedCodes[codeHash]) {
          throw new RequestError("This registration code has already been used.");
        }

        if (Object.keys(state.challenges).length >= 1000) {
          throw new RequestError("Too many active requests. Try later.", 429);
        }

        state.challenges[hash(cookie)] = {
          nonce,
          statement,
          codeHash,
          userId: registration.userId,
          chatId: registration.chatId,
          createdAt: now,
          expiresAt: Math.min(now + 5 * 60_000, registration.expiresAt),
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
        path: "/api/telegram",
        maxAge: 300,
      });

      return response;
    }

    if (body.action !== "link") {
      throw new RequestError("Unknown action.");
    }

    const cookie = readChallengeCookie(request);

    if (!/^[0-9a-f]{64}$/.test(cookie)) {
      throw new RequestError("Prepare a new challenge first.");
    }

    if (
      typeof body.message !== "string" ||
      body.message.length > 8000 ||
      typeof body.address !== "string"
    ) {
      throw new RequestError("Invalid signing response.");
    }

    const messageText = body.message;
    const suppliedAddress = body.address;
    const publicKey = parseHex(body.publicKey, 1312);
    const signature = parseHex(body.signature, 2421);

    if (signature[0] !== 2) {
      throw new RequestError("Unsupported signature version.");
    }

    const address = deriveAddress(publicKey);

    if (address !== suppliedAddress) {
      throw new RequestError("Public key does not match the wallet address.");
    }

    let message: Record<string, unknown>;

    try {
      message = JSON.parse(messageText);
    } catch {
      throw new RequestError("Invalid authentication message.");
    }

    const link = await withState(async (state) => {
      const id = hash(cookie);
      const challenge = state.challenges[id];

      if (!challenge || challenge.expiresAt <= Date.now()) {
        throw new RequestError("Challenge expired or already used.");
      }

      const issuedAt = message.issued_at;
      const nowSeconds = Math.floor(Date.now() / 1000);

      if (
        message.v !== 1 ||
        message.purpose !== "retium-auth" ||
        message.chain_id !== 3 ||
        message.domain !== origin ||
        message.address !== address ||
        typeof message.public_key !== "string" ||
        hex(parseHex(message.public_key, 1312)) !== hex(publicKey) ||
        message.nonce !== challenge.nonce ||
        message.statement !== challenge.statement ||
        typeof issuedAt !== "number" ||
        !Number.isSafeInteger(issuedAt) ||
        issuedAt < Math.floor(challenge.createdAt / 1000) - 30 ||
        issuedAt > nowSeconds + 30
      ) {
        throw new RequestError("Authentication message does not match the challenge.");
      }

      const digest = blake3(
        encoder.encode(`RETIUM_AUTH_V1\n${messageText}`),
      );

      if (!ml_dsa44.verify(signature.slice(1), digest, publicKey)) {
        throw new RequestError("Wallet signature verification failed.");
      }

      if (state.usedCodes[challenge.codeHash]) {
        throw new RequestError("Registration code already used.");
      }

      const existingWallet = state.links[address];
      const existingTelegram = Object.values(state.links).find(
        (item) => item.userId === challenge.userId,
      );

      if (
        (existingWallet && existingWallet.userId !== challenge.userId) ||
        (existingTelegram && existingTelegram.address !== address)
      ) {
        throw new RequestError(
          "Wallet or Telegram account is already linked to another account.",
          409,
        );
      }

      const registrationPath = path.join(directory, "telegram-state.json");
      const registrations = JSON.parse(
        await readFile(registrationPath, "utf8"),
      ).registrations as Record<string, Registration>;

      const current = registrations[challenge.userId];

      if (
        !current ||
        current.expiresAt <= Date.now() ||
        hash(current.code) !== challenge.codeHash
      ) {
        throw new RequestError("Telegram registration expired or changed.");
      }

      const saved: WalletLink = {
        address,
        userId: challenge.userId,
        chatId: challenge.chatId,
        linkedAt: Date.now(),
      };

      state.links[address] = saved;
      state.usedCodes[challenge.codeHash] = Date.now();
      delete state.challenges[id];

      return saved;
    });

    const notificationDelivered = await notifyLinked(link);
    const response = NextResponse.json(
      { linked: true, address: link.address, notificationDelivered },
      { headers: { "Cache-Control": "no-store" } },
    );

    response.cookies.set(cookieName, "", {
      httpOnly: true,
      sameSite: "strict",
      secure: origin.startsWith("https:"),
      path: "/api/telegram",
      maxAge: 0,
    });

    return response;
  } catch (error) {
    const known = error instanceof RequestError;

    return NextResponse.json(
      {
        error: known
          ? error.message
          : "Could not complete verification. Please try again.",
      },
      {
        status: known ? error.status : 500,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
export const maxDuration = 60;
