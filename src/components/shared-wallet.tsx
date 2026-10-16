"use client";
import { UiText } from "./preferences";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import Script from "next/script";
import Link from "next/link";
type Account = { address: string; chainId: number };
type Shared = {
  account: Account | null;
  ready: boolean;
  busy: boolean;
  notice: string;
  remembered: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
};
const Context = createContext<Shared | null>(null);
const storage = "retium-pay:shared-wallet:v1";
export function SharedWalletProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [account, setAccount] = useState<Account | null>(null),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [remembered, setRemembered] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => {
      try {
        const raw = sessionStorage.getItem(storage);
        if (raw) {
          const a = JSON.parse(raw);
          if (/^rete[0-9a-f]{68}$/.test(a.address) && a.chainId === 3 && live) {
            setAccount(a);
            setRemembered(true);
          }
        }
      } catch {
        /* A remembered address is optional, never authentication. */
      }
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, []);
  async function logout() {
    const r = await fetch("/api/payments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logoutList" }),
      cache: "no-store",
    });
    if (!r.ok) throw Error("Could not revoke the viewing session. Try again.");
  }
  async function connect() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setNotice("");
    try {
      if (!window.retium)
        throw Error("Wallet SDK is loading. Wait a moment and try again.");
      // Keep the wallet request directly in the user gesture, before any network await.
      const a = (await window.retium.request({
        method: "retium_requestAccounts",
      })) as Account;
      if (
        !a ||
        !/^rete[0-9a-f]{68}$/.test(a.address) ||
        Number(a.chainId) !== 3
      )
        throw Error("Select the Retium test network (chain 3).");
      if (account && account.address !== a.address) await logout();
      const next = { address: a.address, chainId: 3 };
      setAccount(next);
      setRemembered(false);
      try {
        sessionStorage.setItem(storage, JSON.stringify(next));
      } catch {
        /* In-memory connection still works. */
      }
      setNotice(
        "Wallet selected. Use it across Retium Pay; each signature still needs your approval.",
      );
    } catch (e) {
      setNotice(
        e instanceof Error
          ? e.message
          : "Wallet connection was cancelled or failed.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function disconnect() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await logout();
      try {
        sessionStorage.removeItem(storage);
      } catch {}
      setAccount(null);
      setRemembered(false);
      setNotice(
        "Disconnected from Retium Pay. Existing submitted transactions remain tracked.",
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Disconnect failed.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Context.Provider
      value={{ account, ready, busy, notice, remembered, connect, disconnect }}
    >
      <Script
        src="https://wallet.retium.org/connect/sdk/retium-sdk-1.3.0.js"
        integrity="sha384-FTG6s31+cSLKvZXfREum814s/L2AnqVyikuFQvMKIvFfAz40ksTcaXVbRmkHGGTU"
        crossOrigin="anonymous"
        strategy="afterInteractive"
        onError={() =>
          setNotice("Could not load Web Wallet. Refresh the Dashboard.")
        }
      />
      <div key={account?.address || "disconnected"}>{children}</div>
    </Context.Provider>
  );
}
export function useSharedWallet() {
  const value = useContext(Context);
  if (!value) throw Error("Shared wallet provider is missing.");
  return value;
}
export function DashboardWallet() {
  const w = useSharedWallet();
  const [copied, setCopied] = useState(false);
  return (
    <section className="dashboard-wallet" aria-label="Wallet connection">
      <div>
        <p className="eyebrow">{<UiText text={"YOUR WALLET · CHAIN 3"} />}</p>
        <h2>
          {w.account ? (
            <UiText text={"Your wallet is ready to use"} />
          ) : (
            <UiText text={"Connect once. Use every tool."} />
          )}
        </h2>
        {w.account ? (
          <>
            <p className="shared-wallet-address">
              <code>{w.account.address}</code>
            </p>
            <p className="muted">
              {w.remembered ? (
                <UiText
                  text={
                    "Remembered address. Ownership is verified separately when a signature is required."
                  }
                />
              ) : (
                <UiText
                  text={
                    "Selected on this browser. Signatures and private data still require verification."
                  }
                />
              )}
            </p>
          </>
        ) : (
          <p className="muted">
            {
              <UiText
                text={
                  "Connect here before opening Payments, My History, DEX or Deploy."
                }
              />
            }
          </p>
        )}
      </div>
      <div className="dashboard-wallet-actions">
        <button
          className="button primary"
          disabled={!w.ready || w.busy}
          onClick={() => void w.connect()}
        >
          {w.busy ? (
            <UiText text={"Please wait…"} />
          ) : w.account ? (
            <UiText text={"Change / confirm wallet"} />
          ) : (
            <UiText text={"Connect Wallet"} />
          )}
        </button>
        {w.account && (
          <>
            <button
              className="button secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(w.account!.address);
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? (
                <UiText text={"Copied"} />
              ) : (
                <UiText text={"Copy address"} />
              )}
            </button>
            <button
              className="button secondary"
              disabled={w.busy}
              onClick={() => void w.disconnect()}
            >
              {<UiText text={"Disconnect"} />}
            </button>
          </>
        )}
      </div>
      {w.notice && (
        <p className="shared-wallet-notice" role="status">
          {<UiText text={w.notice} />}
        </p>
      )}
    </section>
  );
}
export function WalletRequired() {
  return (
    <p className="shared-wallet-required">
      {<UiText text={"Select your wallet on the "} />}
      <Link href="/">{<UiText text={"Dashboard →"} />}</Link>
      {<UiText text={" to use this tool."} />}
    </p>
  );
}
export function WalletIndicator() {
  const { account } = useSharedWallet();
  return account ? (
    <Link className="global-wallet-indicator" href="/" title={account.address}>
      {account.address.slice(0, 8)}…{account.address.slice(-6)}
    </Link>
  ) : null;
}
