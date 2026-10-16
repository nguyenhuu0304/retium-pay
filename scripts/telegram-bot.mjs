import { readData as readFile, saveData, checkStorage } from "../src/lib/storage/store.mjs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();

if (!token || token === "DAN_TOKEN_BOT_MOI_VAO_DAY") {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env.local");
  process.exit(1);
}

const dataDirectory = path.resolve("data");
const statePath = path.join(dataDirectory, "telegram-state.json");

if (process.env.DATABASE_URL) await checkStorage();

let state = { offset: 0, registrations: {} };

try {
  state = JSON.parse(await readFile(statePath, "utf8"));

  if (
    !Number.isSafeInteger(state.offset) ||
    state.offset < 0 ||
    !state.registrations ||
    typeof state.registrations !== "object"
  ) {
    throw new Error("Invalid state structure");
  }
} catch (error) {
  if (error.code !== "ENOENT") {
    console.error(
      "Cannot read telegram-state.json. Stopping to protect saved data.",
    );
    process.exit(1);
  }
}

async function saveState() {
  await saveData(statePath, state);
}

class TelegramError extends Error {
  constructor(code) {
    super(`Telegram API returned code ${code}`);
    this.code = code;
  }
}

async function telegram(method, body) {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(40_000),
    },
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new TelegramError(result.error_code ?? response.status);
  }

  return result.result;
}

async function sendMessage(chatId, text, protectContent = true) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    protect_content: protectContent,
  });
}

function registrationFor(message, forceNew = false, usedCodes = {}) {
  const userId = String(message.from.id);
  const previous = state.registrations[userId];
  const profile = { displayName: [message.from.first_name, message.from.last_name].filter(Boolean).join(" ").slice(0, 120), username: typeof message.from.username === "string" ? message.from.username.slice(0, 64) : "" };
  state.profiles ??= {}; state.profiles[userId] = profile;

  if (!forceNew && previous && previous.expiresAt > Date.now() && !usedCodes[createHash("sha256").update(previous.code).digest("hex")]) {
    return previous;
  }

  const registration = {
    userId,
    chatId: String(message.chat.id),
    code: randomBytes(16).toString("hex"),
    createdAt: Date.now(),
    expiresAt: Date.now() + 15 * 60 * 1000,
  };

  state.registrations[userId] = registration;
  return registration;
}

async function readWalletLinks() {
  try {
    const saved = JSON.parse(await readFile(path.join(dataDirectory, "telegram-links.json"), "utf8"));
    if (!saved.links || typeof saved.links !== "object" || !saved.usedCodes || typeof saved.usedCodes !== "object") throw Error("Invalid Telegram wallet link file.");
    return saved;
  } catch (error) { if (error.code === "ENOENT") return { links: {}, usedCodes: {} }; throw error; }
}

async function handleUpdate(update) {
  const message = update.message;

  if (!message?.text || !message.from || message.from.is_bot) return;
  if (message.chat.type !== "private") return;

  const command = message.text.trim().split(/\s+/)[0].toLowerCase();
  const bareCommand = command.split("@")[0];

  if (bareCommand === "/contact") {
    const userId = String(message.from.id);
    state.sharedContacts ??= {};
    if (message.text.trim().split(/\s+/)[1]?.toLowerCase() === "off") {
      delete state.sharedContacts[userId];
      for (const [code, row] of Object.entries(state.contactCodes || {})) if (row.userId === userId) delete state.contactCodes[code];
      await saveState();
      await sendMessage(message.chat.id, "You are no longer listed in Retium Pay's shared member directory. Existing bills and saved contacts are not deleted. Your wallet link is unchanged.");
      return;
    }
    let linked;
    try {
      const auth = JSON.parse(await readFile(path.join(dataDirectory, "telegram-links.json"), "utf8"));
      linked = Object.values(auth.links || {}).find(link => link.userId === userId);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!linked) { await sendMessage(message.chat.id, "Link your wallet on Retium Pay > Telegram first. Then use /contact."); return; }
    state.profiles ??= {};
    state.profiles[userId] = { displayName: [message.from.first_name, message.from.last_name].filter(Boolean).join(" ").slice(0,120), username: typeof message.from.username === "string" ? message.from.username.slice(0,64) : "" };
    state.sharedContacts[userId] = { userId, address: linked.address, updatedAt: Date.now() };
    await saveState();
    await sendMessage(message.chat.id, "Registered in the Retium Pay member directory. Signed-in Retium Pay users can now find your Telegram name, @username and verified public wallet, and add you to their bill contacts. No member code is needed. This does not authorize payments. Use /contact off to stop appearing. Use /contact again after changing your Telegram name to refresh it.");
    return;
  }

  if (bareCommand === "/start" || bareCommand === "/register") {
    const auth = await readWalletLinks();
    const registration = registrationFor(message, bareCommand === "/register", auth.usedCodes);

    // Save the code before attempting delivery.
    await saveState();

    await sendMessage(
      message.chat.id,
      [
        "Welcome to Retium Pay.",
        "",
        "Your registration code:",
        registration.code,
        "",
        "Valid for 15 minutes. Keep this code private.",
        "",
        "Link your wallet on Retium Pay > Telegram.",
        "This code alone does not link or verify a wallet.",
        "",
        "Use /register for a NEW code. Only the latest code is valid.",
        "Use /status to check your registration.",
      ].join("\n"),
    );

    return;
  }

  if (bareCommand === "/status") {
    const userId = String(message.from.id);
    const auth = await readWalletLinks();
    const linked = Object.values(auth.links).find(item => item.userId === userId);
    const registration = state.registrations[userId];
    const used = registration && !!auth.usedCodes[createHash("sha256").update(registration.code).digest("hex")];
    const active = registration && registration.expiresAt > Date.now() && !used;
    const enrolled = linked && state.sharedContacts?.[userId]?.address === linked.address;
    await sendMessage(message.chat.id, linked
      ? `Wallet linked and verified:\n${linked.address}\n\nMember directory: ${enrolled ? "registered" : "not registered — send /contact"}. No need to link again for the same wallet.`
      : active ? "Wallet not linked yet. Your latest registration code is active. Paste it into Retium Pay > Telegram, prepare verification, then sign and link."
      : used ? "Your previous registration code was already used. Send /register for a fresh code."
      : "Wallet not linked. Send /register for a fresh code, then verify your wallet on Retium Pay > Telegram.");
    return;
  }

  await sendMessage(
    message.chat.id,
    [
      "Retium Pay commands:",
      "/register — Get a registration code",
      "/status — Check registration status",
      "",
      "/contact — Register in the shared member directory",
      "/contact off — Stop appearing in the member directory",
      "Testnet only. Never share your seed or private key.",
    ].join("\n"),
  );
}

let stopping = false;
const pause = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

process.on("SIGINT", () => {
  stopping = true;
  console.log("Stopping after the current request…");
});

process.on("SIGTERM", () => {
  stopping = true;
});

try {
  const me = await telegram("getMe", {});
  const webhook = await telegram("getWebhookInfo", {});

  if (webhook.url) {
    console.error(
      "This bot already has a webhook. Polling was not started.",
    );
    process.exit(1);
  }

  console.log(`Retium Pay Telegram bot online: @${me.username}`);
  console.log("Wallet registration and member contact codes ready.");

  while (!stopping) {
    try {
      const updates = await telegram("getUpdates", {
        offset: state.offset,
        timeout: 25,
        allowed_updates: ["message"],
      });

      for (const update of updates) {
        if (stopping) break;

        try {
          await handleUpdate(update);
        } catch (error) {
          // A blocked bot cannot deliver to that chat; skip this update.
          if (!(error instanceof TelegramError && error.code === 403)) {
            throw error;
          }
          console.warn("Delivery unavailable for one chat.");
        }

        state.offset = update.update_id + 1;
        await saveState();
      }
    } catch (error) {
      if (
        error instanceof TelegramError &&
        (error.code === 401 || error.code === 409)
      ) {
        console.error(
          error.code === 401
            ? "Invalid Telegram token. Check .env.local."
            : "Another process is polling this bot. Stop the duplicate process.",
        );
        process.exitCode = 1;
        break;
      }

      console.warn("Telegram request failed. Retrying in 5 seconds.");
      await pause(5000);
    }
  }
} catch {
  console.error(
    "Could not start Telegram bot. Check token and network connection.",
  );
  process.exitCode = 1;
}