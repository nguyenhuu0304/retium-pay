"use client";
import { UiText, UiInput } from "../../components/preferences";

import {
  useSharedWallet,
  WalletRequired,
} from "../../components/shared-wallet";
import Link from "next/link";
import { useRef, useState } from "react";
type Challenge = { nonce: string; statement: string };
type AuthResult = {
  address: string;
  message: string;
  signature: string;
  publicKey: string;
};
type Provider = {
  request(input: {
    method: string;
    params?: Record<string, unknown>;
  }): Promise<unknown>;
};
async function api(body: Record<string, unknown>) {
  const response = await fetch("/api/telegram/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Linking failed.");
  return data;
}
function errorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Could not complete wallet linking.";
}
export default function TelegramPage() {
  const { account } = useSharedWallet();
  const selectedWallet = account?.address || "";
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const lock = useRef(false);
  const normalized = code.replace(/[\s\u200b-\u200d\ufeff]/g, "").toLowerCase();
  async function prepare() {
    if (!selectedWallet) {
      setNotice("Select your wallet on the Dashboard first.");
      return;
    }
    if (lock.current) return;
    if (!/^[0-9a-f]{32}$/.test(normalized)) {
      setNotice("Paste the complete 32-character registration code.");
      return;
    }
    lock.current = true;
    setBusy(true);
    setNotice("");
    setChallenge(null);
    try {
      const data = await api({ action: "challenge", code: normalized });
      setChallenge({ nonce: data.nonce, statement: data.statement });
      setNotice(
        "Ready to sign. Select the wallet you want to link in Web Wallet.",
      );
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function sign() {
    const wallet = (window as unknown as { retium?: Provider }).retium;
    if (!wallet) {
      setNotice("Refresh to load the Wallet connector.");
      return;
    }
    if (!challenge || lock.current) return;
    lock.current = true;
    setBusy(true);
    setNotice("");
    try {
      const result = (await wallet.request({
        method: "retium_signAuth",
        params: challenge,
      })) as AuthResult;
      if (result.address !== selectedWallet)
        throw Error(
          "The signing account differs from your Dashboard wallet. No link was saved.",
        );
      const data = await api({ action: "link", ...result });
      if (data.linked !== true)
        throw new Error("Wallet link was not confirmed.");
      setAddress(data.address);
      setCode("");
      setChallenge(null);
      setNotice(
        data.notificationDelivered
          ? "Wallet verified and linked. Confirmation sent to Telegram."
          : "Wallet linked. Telegram confirmation delivery is not confirmed.",
      );
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <main
        className="app-shell"
        style={{ maxWidth: 900, paddingTop: 40, paddingBottom: 40 }}
      >
        <section className="wallet-card" style={{ marginTop: 25 }}>
          <p className="eyebrow">{<UiText text={"RETIUM TESTNET"} />}</p>
          <h1 style={{ fontSize: 38 }}>{<UiText text={"Link Telegram"} />}</h1>
          {!selectedWallet ? (
            <WalletRequired />
          ) : (
            <p className="muted" style={{ overflowWrap: "anywhere" }}>
              {<UiText text={"Selected wallet: "} />}
              {selectedWallet}
            </p>
          )}
          <p className="muted">
            {
              <UiText
                text={
                  "Verify wallet ownership to receive payment notifications. This signature does not transfer funds."
                }
              />
            }
          </p>
          <ol style={{ paddingLeft: 24, lineHeight: 1.8 }}>
            <li>
              {<UiText text={"Open"} />}{" "}
              <a
                href="https://t.me/RetiumPay_Bot"
                target="_blank"
                rel="noopener noreferrer"
                className="text-button"
              >
                {<UiText text={"@RetiumPay_Bot"} />}
              </a>{" "}
              {<UiText text={"and send /register."} />}
            </li>
            <li>{<UiText text={"Paste the registration code below."} />}</li>
            <li>
              {
                <UiText
                  text={
                    "Prepare verification, then sign with the wallet you want to link."
                  }
                />
              }
            </li>
          </ol>
          <label htmlFor="code" className="detail-label">
            {<UiText text={"Registration code"} />}
          </label>
          <UiInput
            id="code"
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            value={code}
            maxLength={256}
            onChange={(e) => {
              setCode(e.target.value);
              setChallenge(null);
              setAddress("");
            }}
            style={{
              width: "100%",
              padding: 14,
              marginTop: 8,
              border: "1px solid #383b45",
              borderRadius: 10,
              background: "#101114",
              color: "white",
            }}
          />
          <p className="muted">
            {normalized.length}
            {<UiText text={"/32 characters"} />}
          </p>
          <div className="hero-actions">
            <button
              className="button secondary"
              disabled={busy || !normalized || !selectedWallet}
              onClick={prepare}
            >
              {<UiText text={"1. Prepare verification"} />}
            </button>
            <button
              className="button primary"
              disabled={busy || !challenge}
              onClick={sign}
            >
              {<UiText text={"2. Sign and link"} />}
            </button>
          </div>
          {address && (
            <div className="account-details">
              <span className="detail-label">
                {<UiText text={"Verified wallet"} />}
              </span>
              <code style={{ overflowWrap: "anywhere" }}>{address}</code>
            </div>
          )}
          {notice && (
            <div className="notice" role="status" style={{ marginTop: 20 }}>
              {<UiText text={notice} />}
            </div>
          )}
          <div style={{ marginTop: 24 }}>
            <Link href="/payments" className="text-button">
              {<UiText text={"Open payment requests"} />}
            </Link>
          </div>
        </section>
      </main>
    </>
  );
}
