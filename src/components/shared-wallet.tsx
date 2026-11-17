"use client";
import { CopyValue } from "./copy-value";
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
const storage = "retiump4y:shared-wallet:v1";

function validAccount(value: unknown): Account | null {
  if (!value || typeof value !== "object") return null;
  const account = value as { address?: unknown; chainId?: unknown };
  if (
    typeof account.address !== "string" ||
    !/^rete[0-9a-f]{68}$/.test(account.address) ||
    Number(account.chainId) !== 3
  ) return null;
  return { address: account.address, chainId: 3 };
}

function waitForRetium(timeoutMs = 500): Promise<typeof window.retium | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.retium) return Promise.resolve(window.retium);
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener("retium#initialized", finish);
      resolve(window.retium ?? null);
    };
    window.addEventListener("retium#initialized", finish, { once: true });
    window.setTimeout(finish, timeoutMs);
  });
}

export function SharedWalletProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [remembered, setRemembered] = useState(false);
  const lock = useRef(false);

  function saveAccount(next: Account | null) {
    setAccount(next);
    setRemembered(false);
    try {
      if (next) {
        localStorage.setItem(storage, JSON.stringify(next));
        sessionStorage.setItem(storage, JSON.stringify(next));
      } else {
        localStorage.removeItem(storage);
        sessionStorage.removeItem(storage);
      }
    } catch {
      // The verified in-memory connection remains usable for this page.
    }
  }

  useEffect(() => {
    let live = true;
    async function restoreVerifiedWallet() {
      try {
        const provider = await waitForRetium();
        if (!live) return;
        if (!provider) {
          setNotice("Retium Wallet was not detected. Install or unlock the wallet, then connect.");
          return;
        }
        // A saved address is never treated as a live connection. Ask the wallet
        // again so account switches and revoked site permissions are respected.
        const result = await provider.request({ method: "retium_requestAccounts" });
        if (!live) return;
        const next = validAccount(result);
        if (!next) {
          saveAccount(null);
          setNotice("Select the Retium test network (chain 3) in your wallet.");
          return;
        }
        saveAccount(next);
        setNotice("");
      } catch (error) {
        if (!live) return;
        const code = typeof error === "object" && error !== null && "code" in error
          ? Number((error as { code?: unknown }).code)
          : 0;
        // 4001 means the user declined. A decline is not an application error.
        if (code !== 4001) setNotice(error instanceof Error ? error.message : "Wallet restore failed. Connect again.");
        saveAccount(null);
      } finally {
        if (live) setReady(true);
      }
    }
    void restoreVerifiedWallet();
    return () => { live = false; };
  }, []);

  async function logout() {
    const response = await fetch("/api/payments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logoutList" }),
      cache: "no-store",
    });
    if (!response.ok) throw Error("Could not revoke the viewing session. Try again.");
  }

  async function connect() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setNotice("");
    try {
      const provider = await waitForRetium();
      if (!provider) throw Error("Retium Wallet is unavailable. Install or unlock the wallet and retry.");
      // Keep the account request in the connect action; the wallet owns all keys.
      const result = await provider.request({ method: "retium_requestAccounts" });
      const next = validAccount(result);
      if (!next) throw Error("Select the Retium test network (chain 3).");
      if (account && account.address !== next.address) await logout();
      saveAccount(next);
      setNotice("Wallet verified. Every transaction still requires your approval in Retium Wallet.");
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? Number((error as { code?: unknown }).code)
        : 0;
      setNotice(code === 4001 ? "Wallet connection was cancelled." : error instanceof Error ? error.message : "Wallet connection failed.");
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
      saveAccount(null);
      setNotice("Disconnected from RetiumP4y. Submitted transactions remain tracked.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Disconnect failed.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <Context.Provider value={{ account, ready, busy, notice, remembered, connect, disconnect }}>
      <Script
        src="https://wallet.retium.org/connect/sdk/retium-sdk-1.5.0.js"
        integrity="sha384-IZZw04xxx1GLXviLZ7lw+B5XTi4SNw7Y6fUYf2zdJ8b54pBxVv5KqdvLSjQhZL3v"
        crossOrigin="anonymous"
        strategy="afterInteractive"
        onError={() => setNotice("Could not load Retium Wallet SDK. Refresh this page.")}
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
  const wallet = useSharedWallet();
  const [copied, setCopied] = useState(false);
  return (
    <section className="dashboard-wallet" aria-label="Wallet connection">
      <div>
        <p className="eyebrow"><UiText text={"YOUR WALLET · CHAIN 3"} /></p>
        <h2>{wallet.account ? <UiText text={"Your wallet is ready to use"} /> : <UiText text={"Connect once. Use every tool."} />}</h2>
        {wallet.account ? (
          <>
            <p className="shared-wallet-address"><CopyValue value={wallet.account.address} compact /></p>
            <p className="muted"><UiText text={"Wallet verified by Retium Wallet for this page. Signatures and private data still require separate approval."} /></p>
          </>
        ) : (
          <p className="muted"><UiText text={"Connect here before opening Payments, My History, DEX or Deploy."} /></p>
        )}
      </div>
      <div className="dashboard-wallet-actions">
        <button className={wallet.account ? "button secondary" : "button primary"} disabled={!wallet.ready || wallet.busy} onClick={() => void wallet.connect()}>
          {wallet.busy ? <UiText text={"Please wait…"} /> : wallet.account ? <UiText text={"Change / confirm wallet"} /> : <UiText text={"Connect Wallet"} />}
        </button>
        {wallet.account && (
          <>
            <button className="button secondary" onClick={async () => {
              try { await navigator.clipboard.writeText(wallet.account!.address); setCopied(true); }
              catch { setCopied(false); }
            }}>{copied ? <UiText text={"Copied"} /> : <UiText text={"Copy address"} />}</button>
            <button className="button secondary" disabled={wallet.busy} onClick={() => void wallet.disconnect()}><UiText text={"Disconnect"} /></button>
          </>
        )}
      </div>
      {wallet.notice && <p className="shared-wallet-notice" role="status"><UiText text={wallet.notice} /></p>}
    </section>
  );
}

export function WalletRequired() {
  return (
    <p className="shared-wallet-required">
      <UiText text={"Select your wallet on the "} />
      <Link href="/"><UiText text={"Dashboard →"} /></Link>
      <UiText text={" to use this tool."} />
    </p>
  );
}

export function WalletIndicator() {
  const wallet = useSharedWallet();
  if (!wallet.account) return <Link className="wallet-select-link" href="/"><UiText text="Connect Wallet" /></Link>;
  return (
    <details className="wallet-menu">
      <summary title={wallet.account.address}><span className="connection-dot" /><code>{wallet.account.address.slice(0, 10)}…{wallet.account.address.slice(-7)}</code></summary>
      <div>
        <p className="wallet-menu-label"><UiText text="Wallet connected" /></p>
        <CopyValue value={wallet.account.address} compact />
        <button disabled={!wallet.ready || wallet.busy} onClick={() => void wallet.connect()}><UiText text="Change / confirm wallet" /></button>
        <button disabled={wallet.busy} onClick={() => void wallet.disconnect()}><UiText text="Disconnect" /></button>
      </div>
    </details>
  );
}
