"use client";
import { CopyValue } from "../../components/copy-value";
import { UiText, UiInput } from "../../components/preferences";

import {
  useSharedWallet,
  WalletRequired,
} from "../../components/shared-wallet";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Plan } from "../../lib/dex/math";
import "../tools.css";
type Preview = { plan: Plan; ticket: string; wasmBase64: string };
type Saved = {
  wallet: string;
  ticket: string;
  contractId: string;
  txId?: string;
};
type Job = { state: string; notice: string; error?: string };
const storage = "retium-pay:deploy:v1";
const err = (e: unknown) =>
  e instanceof Error
    ? e.message
    : typeof e === "object" && e && "message" in e
      ? String(e.message)
      : "Request failed.";
async function post(url: string, body: object) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || "Request failed.");
  return d;
}
export default function Deploy() {
  const { account } = useSharedWallet();
  const wallet = account?.address || "";
  const [session, setSession] = useState(false);
  const [challenge, setChallenge] = useState<Record<string, unknown> | null>(
    null,
  );
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [supply, setSupply] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [notice, setNotice] = useState(
    "Review your test token, then approve the deployment in Web Wallet.",
  );
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [historyChecked, setHistoryChecked] = useState(false);
  const running = useRef(false);
  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => {
      try {
        const raw = localStorage.getItem(storage);
        if (raw) {
          const d = JSON.parse(raw);
          if (
            /^rete[0-9a-f]{68}$/.test(d.wallet) &&
            /^[0-9a-f]{64}$/.test(d.contractId) &&
            typeof d.ticket === "string"
          ) {
            if (active) {
              setSaved(d);
            }
          } else throw Error();
        }
      } catch {
        if (active)
          setNotice(
            "Could not read deployment recovery data. Check Wallet history before deploying again.",
          );
      }
      if (active) setReady(true);
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(() => {
      setPreview(null);
      setAgreed(false);
      setNotice("Preview expired. Review again before signing.");
    }, 60000);
    return () => clearTimeout(timer);
  }, [preview]);
  const jobState = job?.state,
    jobNotice = job?.notice;
  useEffect(() => {
    if (
      !saved?.txId ||
      !session ||
      saved.wallet !== wallet ||
      (jobState &&
        jobState !== "pending" &&
        !["pending", "sending"].includes(jobNotice || ""))
    )
      return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      try {
        await post("/api/payments", {
          operation: "dexRegister",
          ticket: saved!.ticket,
          txId: saved!.txId,
        });
        const d = await post("/api/payments", {
          operation: "dexCheck",
          txId: saved!.txId,
        });
        if (!stopped) setJob(d.job);
      } catch (e) {
        if (!stopped)
          setNotice(
            `${err(e)} Restore the wallet session if it expired. The background monitor keeps registered transactions.`,
          );
      } finally {
        if (!stopped) timer = setTimeout(tick, 7000);
      }
    }
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [saved, session, wallet, jobState, jobNotice]);
  async function action(fn: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setNotice(err(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!wallet) return;
    const c = new AbortController();
    fetch("/api/payments?action=session", {
      cache: "no-store",
      signal: c.signal,
    })
      .then((r) => r.json())
      .then((d) => {
        if (!c.signal.aborted)
          setSession(d.address === wallet && d.expiresAt > Date.now());
      })
      .catch(() => {});
    return () => c.abort();
  }, [wallet]);
  function authenticate() {
    void action(async () => {
      if (!challenge) {
        setChallenge(
          await post("/api/payments", {
            action: "prepareList",
            address: wallet,
          }),
        );
        setNotice("Click Verify wallet. This signature does not send funds.");
        return;
      }
      if (!window.retium) throw Error("Wallet unavailable.");
      const auth = (await window.retium.request({
        method: "retium_signAuth",
        params: challenge,
      })) as Record<string, unknown>;
      if (auth.address !== wallet)
        throw Error("Wallet account changed. Reconnect.");
      await post("/api/payments", { action: "verifyList", ...auth });
      setSession(true);
      setChallenge(null);
      setNotice(
        "Tracking ready. Telegram uses the account linked to this wallet.",
      );
    });
  }
  function review() {
    void action(async () => {
      setPreview(null);
      setAgreed(false);
      const d = await post("/api/dex", {
        operation: "prepareDeploy",
        wallet,
        name,
        symbol,
        supply,
      });
      setPreview(d);
      setNotice(
        "Review the token and contract ID, then sign separately in Web Wallet.",
      );
    });
  }
  function deploy() {
    void action(async () => {
      if (!preview || !agreed || !session || !window.retium || saved)
        throw Error("Review the token and enable tracking first.");
      if (Date.now() > preview.plan.expiresAt)
        throw Error("Preview expired. Review again.");
      const hold: Saved = {
        wallet,
        ticket: preview.ticket,
        contractId: preview.plan.call.contractId,
      };
      // Persist before opening Wallet. Any ambiguous outcome blocks another submission.
      localStorage.setItem(storage, JSON.stringify(hold));
      setSaved(hold);
      setJob(null);
      setPreview(null);
      try {
        const result = (await window.retium.request({
          method: "retium_deploy",
          params: {
            wasmBase64: preview.wasmBase64,
            metadata: preview.plan.deployment!.metadata,
          },
        })) as { txId: string; contractId: string };
        if (!/^tx_[0-9a-f]{32}$/.test(result.txId))
          throw Error(
            "Wallet did not return a valid TX ID. Check its history.",
          );
        const next = { ...hold, txId: result.txId };
        localStorage.setItem(storage, JSON.stringify(next));
        setSaved(next);
        if (result.contractId !== hold.contractId)
          throw Error(
            "Wallet returned a different contract ID. Do not retry; check the Explorer.",
          );
        const d = await post("/api/payments", {
          operation: "dexRegister",
          ticket: next.ticket,
          txId: next.txId,
        });
        setJob(d.job);
        setNotice(
          "Submitted. Waiting for HardFinal and contract code verification.",
        );
      } catch (e) {
        const code =
          typeof e === "object" && e && "code" in e ? String(e.code) : "";
        if (["4001", "4300"].includes(code)) {
          localStorage.removeItem(storage);
          setSaved(null);
          setNotice("Wallet declined the request. Review again when ready.");
        } else throw e;
      }
    });
  }
  const terminal = job && job.state !== "pending";
  return (
    <main className="tool-page">
      <header>
        <p className="eyebrow">{<UiText text={"RETIUM PAY · TESTNET"} />}</p>
        <h1>{<UiText text={"Deploy a token"} />}</h1>
        <p>
          {
            <UiText
              text={
                "Create a fungible token in Retium Pay. Deployment does not add liquidity."
              }
            />
          }
        </p>
      </header>
      <div className="tool-grid">
        <section className="tool-card">
          {!wallet && <WalletRequired />}
          {wallet && (
            <>
              <p className="wrap">
                <CopyValue value={wallet} />
              </p>
              <button disabled={busy} onClick={authenticate}>
                {session ? (
                  <UiText text={"Refresh tracking session"} />
                ) : challenge ? (
                  <UiText text={"Verify wallet"} />
                ) : (
                  <UiText text={"Enable Telegram tracking"} />
                )}
              </button>
            </>
          )}
          <label>
            {<UiText text={"Token name"} />}
            <UiInput
              maxLength={48}
              value={name}
              disabled={busy || !!saved}
              onChange={(e) => {
                setName(e.target.value);
                setPreview(null);
              }}
              placeholder="My Test Token"
            />
          </label>
          <label>
            {<UiText text={"Symbol"} />}
            <UiInput
              maxLength={8}
              value={symbol}
              disabled={busy || !!saved}
              onChange={(e) => {
                setSymbol(e.target.value.toUpperCase());
                setPreview(null);
              }}
              placeholder="MTT"
            />
          </label>
          <label>
            {<UiText text={"Initial supply"} />}
            <UiInput
              inputMode="numeric"
              value={supply}
              disabled={busy || !!saved}
              onChange={(e) => {
                setSupply(e.target.value);
                setPreview(null);
              }}
            />
          </label>
          <p>
            {
              <UiText
                text={"18 decimals · Wallet displays the actual network fee."}
              />
            }
          </p>
          <button
            disabled={busy || !ready || !wallet || !session || !!saved}
            onClick={review}
          >
            {<UiText text={"Review token"} />}
          </button>
        </section>
        <section className="tool-card" aria-live="polite">
          <p role="status">{<UiText text={notice} />}</p>
          {preview && (
            <>
              <h2>{<UiText text={"Review deployment"} />}</h2>
              {preview.plan.summary.map((line) => (
                <p key={line}>{line}</p>
              ))}
              <p className="wrap">
                {<UiText text={"Contract: "} />}
                <CopyValue value={preview.plan.call.contractId} />
              </p>
              <label className="inline-check">
                <UiInput
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                />
                {
                  <UiText
                    text={
                      "I checked the name, supply and wallet. Testnet only."
                    }
                  />
                }
              </label>
              <button disabled={busy || !agreed} onClick={deploy}>
                {<UiText text={"Sign deployment in Web Wallet"} />}
              </button>
            </>
          )}
          {saved && (
            <>
              <h2>
                {job?.state === "confirmed" ? (
                  <UiText text={"✓ Token deployed"} />
                ) : terminal ? (
                  <UiText text={"Needs attention"} />
                ) : (
                  <UiText text={"Deployment tracking"} />
                )}
              </h2>
              <p className="wrap">
                {<UiText text={"Contract: "} />}
                <CopyValue value={saved.contractId} />
              </p>
              {saved.txId ? (
                <p className="wrap">
                  {<UiText text={"TX: "} />}
                  <CopyValue value={saved.txId} />
                </p>
              ) : (
                <p>
                  {
                    <UiText
                      text={
                        "Outcome unknown. Check Web Wallet history and the Explorer before continuing. Do not submit the deployment again."
                      }
                    />
                  }
                </p>
              )}
              <p>
                {<UiText text={"Status:"} />}{" "}
                {job?.state === "confirmed" ? (
                  <UiText text={"HardFinal · code verified"} />
                ) : (
                  job?.state || "Awaiting verification"
                )}
              </p>
              {job?.error && <p>{job.error}</p>}
              {job && (
                <p>
                  {<UiText text={"Telegram: "} />}
                  {<UiText text={job.notice} />}
                  {job.notice === "unlinked" && (
                    <>
                      {" "}
                      —{" "}
                      <Link href="/telegram">
                        {
                          <UiText
                            text={"link your Telegram for future transactions"}
                          />
                        }
                      </Link>
                    </>
                  )}
                </p>
              )}
              {!saved.txId && (
                <label>
                  {<UiText text={"Recover TX ID from Wallet history"} />}
                  <UiInput
                    placeholder="tx_…"
                    onBlur={(e) => {
                      const txId = e.target.value.trim();
                      if (/^tx_[0-9a-f]{32}$/.test(txId)) {
                        const next = { ...saved, txId };
                        localStorage.setItem(storage, JSON.stringify(next));
                        setSaved(next);
                      }
                    }}
                  />
                </label>
              )}
              {(terminal || !saved.txId) && (
                <>
                  <label className="inline-check">
                    <UiInput
                      type="checkbox"
                      checked={historyChecked}
                      onChange={(e) => setHistoryChecked(e.target.checked)}
                    />
                    {
                      <UiText
                        text={
                          "I checked the final result in Wallet / Explorer."
                        }
                      />
                    }
                  </label>
                  <button
                    disabled={!historyChecked || busy}
                    onClick={() => {
                      localStorage.removeItem(storage);
                      setSaved(null);
                      setJob(null);
                      setHistoryChecked(false);
                      setNotice(
                        "Ready for a new token. Use a different name or symbol for a new contract.",
                      );
                    }}
                  >
                    {<UiText text={"Close this deployment"} />}
                  </button>
                </>
              )}
            </>
          )}
        </section>
      </div>
      <p className="tool-note">
        {
          <UiText
            text={
              "Contract creation uses your Web Wallet signature. Never enter a seed phrase or private key here. Keep the Background Monitor running for Telegram delivery when this page is closed."
            }
          />
        }
      </p>
    </main>
  );
}
