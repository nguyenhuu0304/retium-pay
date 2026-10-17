"use client";
import { readPayerNonce } from "../../lib/payments/browser";
import {
  MemberIdentity,
  type TelegramName,
} from "../../components/member-identity";
import { CopyValue } from "../../components/copy-value";
import { UiText, UiInput } from "../../components/preferences";

import {
  useSharedWallet,
  WalletRequired,
} from "../../components/shared-wallet";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type Payment = {
  id: string;
  recipient: string;
  payer: string;
  amountRtm: string;
  amountAtomic: string;
  description: string;
  createdAt: number;
  status: "requested" | "processing" | "paid";
  notification: string;
  txId?: string | null;
  payerLabel?: string;
  payerTelegram?: TelegramName;
  paidAt?: number | null;
  paymentPhase?: string;
  paymentError?: string | null;
};
type Challenge = { nonce: string; statement: string };
type AuthResult = {
  address: string;
  publicKey: string;
  signature: string;
  message: string;
};
type Provider = {
  request(input: {
    method: string;
    params?: Record<string, unknown>;
  }): Promise<unknown>;
};
function provider() {
  return (window as unknown as { retium?: Provider }).retium;
}
function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
}
function describeError(error: unknown) {
  return error instanceof Error
    ? error.message
    : typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : "Request failed.";
}
async function api(body: Record<string, unknown>) {
  const response = await fetch("/api/payments", {
    signal: AbortSignal.timeout(30000),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    keepalive: body.action === "attachTx",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}
const inputStyle = {
  width: "100%",
  padding: 14,
  background: "#101114",
  border: "1px solid #383b45",
  borderRadius: 10,
  color: "white",
  marginTop: 6,
  marginBottom: 18,
};
const codeStyle = { overflowWrap: "anywhere" as const };
function localKey(id: string) {
  return `retium-pay-transfer:${id}`;
}
function rememberTx(id: string, txId: string) {
  try {
    localStorage.setItem(localKey(id), txId);
  } catch {
    /* The server remains authoritative. */
  }
}

export default function PaymentsPage() {
  const { account } = useSharedWallet();
  const address = account?.address || "";
  const [payer, setPayer] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [payChallenge, setPayChallenge] = useState<Challenge | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [shareUrl, setShareUrl] = useState("");
  const [recoveryTx, setRecoveryTx] = useState("");
  const [readyToSend, setReadyToSend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [delivery, setDelivery] = useState<string[]>([]);
  const operation = useRef(false);
  const sendAllowed = useRef(false);
  const paymentId = payment?.id;
  const poll =
    payment?.status === "processing" && payment.paymentPhase !== "unknown";

  useEffect(() => {
    const id = new URL(window.location.href).searchParams.get("id");
    if (!id) return;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(
          `/api/payments?id=${encodeURIComponent(id!)}`,
          {
            cache: "no-store",
            signal: controller.signal,
          },
        );
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error || "Could not load request.");
        if (controller.signal.aborted) return;
        setPayment(data.payment);
        setDelivery(data.paidNotifications || []);
        setShareUrl(window.location.href);
        try {
          setRecoveryTx(
            localStorage.getItem(localKey(id!)) || data.payment.txId || "",
          );
        } catch {
          /* Optional recovery aid. */
        }
      } catch (error) {
        if (!controller.signal.aborted) setNotice(describeError(error));
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!paymentId || !poll) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      if (stopped) return;
      if (!operation.current) {
        try {
          const data = await api({ action: "checkPay", id: paymentId });
          if (stopped) return;
          setPayment(data.payment);
          setDelivery(data.paidNotifications || []);
          if (data.payment.status === "paid") {
            setNotice(
              "Payment verified: HardFinal. No further transfer is needed.",
            );
            return;
          }
          if (data.payment.paymentPhase === "unknown") return;
        } catch (error) {
          if (!stopped)
            setNotice(
              `${describeError(error)} Use Verify payer if this browser session expired.`,
            );
        }
      }
      if (!stopped) timer = setTimeout(check, 15_000);
    }
    timer = setTimeout(check, 5_000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [paymentId, poll]);

  function begin() {
    if (operation.current) return false;
    operation.current = true;
    setBusy(true);
    setNotice("");
    return true;
  }
  function end() {
    operation.current = false;
    setBusy(false);
  }

  async function prepare() {
    if (!begin()) return;
    setChallenge(null);
    try {
      const data = await api({
        action: "prepare",
        recipient: address,
        payer: payer.trim(),
        amount: amount.trim(),
        description: description.trim(),
      });
      setChallenge({ nonce: data.nonce, statement: data.statement });
    } catch (error) {
      setNotice(describeError(error));
    } finally {
      end();
    }
  }
  async function create() {
    const wallet = provider();
    if (!wallet || !challenge || !begin()) return;
    try {
      const result = (await wallet.request({
        method: "retium_signAuth",
        params: challenge,
      })) as AuthResult;
      if (result.address !== address)
        throw Error("The signing account differs from the Dashboard wallet.");
      const data = await api({ action: "create", ...result });
      setPayment(data.payment);
      const url = new URL("/payments", window.location.origin);
      url.searchParams.set("id", data.payment.id);
      setShareUrl(url.toString());
      window.history.replaceState(null, "", url);
      setChallenge(null);
      setNotice(
        data.payment.notification === "sent"
          ? "Request saved. Telegram request notification sent."
          : "Request saved. Telegram delivery is not confirmed.",
      );
    } catch (error) {
      setNotice(describeError(error));
    } finally {
      end();
    }
  }
  async function preparePay() {
    if (!payment || !begin()) return;
    setPayChallenge(null);
    try {
      if (address !== payment.payer) throw Error("Connect the requested payer wallet first.");
      // Existing attempts restore checking with their saved nonce; never enable a second send.
      const payerSnapshot = ["reserved", "submitted", "review", "paid"].includes(payment.paymentPhase || "")
        ? undefined
        : await readPayerNonce(payment.payer);
      const data = await api({ action: "preparePay", id: payment.id, payerSnapshot });
      setPayChallenge({ nonce: data.nonce, statement: data.statement });
      setNotice(
        data.recovery
          ? "Sign as the payer to restore checking. This will not enable a second transfer."
          : "Sign to verify the payer. A separate Pay approval will send RTM.",
      );
    } catch (error) {
      setNotice(describeError(error));
    } finally {
      end();
    }
  }
  async function authorizePay() {
    const wallet = provider();
    if (!wallet || !payChallenge || !payment || !begin()) return;
    try {
      const result = (await wallet.request({
        method: "retium_signAuth",
        params: payChallenge,
      })) as AuthResult;
      const data = await api({
        action: "authorizePay",
        id: payment.id,
        ...result,
      });
      setPayment(data.payment);
      setPayChallenge(null);
      sendAllowed.current = data.readyToSend === true;
      setReadyToSend(data.readyToSend === true);
      setNotice(
        data.readyToSend
          ? "Payer verified. Check the amount and recipient, then click Pay once. Do not make other transactions from this wallet before payment completes."
          : "Checking restored. Check the existing TX; do not send again.",
      );
    } catch (error) {
      setNotice(describeError(error));
    } finally {
      end();
    }
  }
  async function send() {
    const wallet = provider();
    if (!wallet || !payment || !sendAllowed.current || !begin()) return;
    sendAllowed.current = false;
    setReadyToSend(false);
    try {
      // No network request or timeout before the Wallet popup opens.
      const result = (await wallet.request({
        method: "retium_sendTransfer",
        params: {
          to: payment.recipient,
          amountAtomic: payment.amountAtomic,
        },
      })) as { txId?: string };
      if (!result.txId || !/^tx_[0-9a-f]{32}$/.test(result.txId))
        throw new Error(
          "Wallet returned no valid TX ID. Check Wallet history; do not send again.",
        );
      rememberTx(payment.id, result.txId);
      setRecoveryTx(result.txId);
      setNotice(
        `TX submitted: ${result.txId}. Waiting for HardFinal; do not send again.`,
      );
      const data = await api({
        action: "attachTx",
        id: payment.id,
        txId: result.txId,
      });
      setPayment(data.payment);
      setDelivery(data.paidNotifications || []);
      if (data.payment.status === "paid")
        setNotice("Payment confirmed: HardFinal.");
      else
        setNotice(
          "TX saved. Background monitoring can continue if the payments worker is running. You may close this tab after this message.",
        );
    } catch (error) {
      const code = errorCode(error);
      if (code === "4001" || code === "4300") {
        try {
          const data = await api({ action: "cancelPay", id: payment.id });
          setPayment(data.payment);
          setNotice(
            "Wallet rejected or refused the transfer. You can prepare payment verification again.",
          );
        } catch {
          setNotice(
            "Could not reset the attempt. Check Wallet history before proceeding.",
          );
        }
      } else {
        setNotice(
          `${describeError(error)} Check Wallet history and paste the TX ID below. Do not send again.`,
        );
      }
    } finally {
      end();
    }
  }
  async function checkPayment(attach: boolean) {
    if (!payment || !begin()) return;
    try {
      const data = await api({
        action: attach ? "attachTx" : "checkPay",
        id: payment.id,
        ...(attach ? { txId: recoveryTx.trim() } : {}),
      });
      setPayment(data.payment);
      setDelivery(data.paidNotifications || []);
      setNotice(
        data.payment.status === "paid"
          ? "Payment confirmed: HardFinal."
          : data.payment.paymentError ||
              "Payment is not confirmed yet. Check the TX; do not send again.",
      );
    } catch (error) {
      setNotice(describeError(error));
    } finally {
      end();
    }
  }
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setNotice("Request link copied.");
    } catch {
      setNotice("Select and copy the share link manually.");
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
          <h1 style={{ fontSize: 38 }}>
            {<UiText text={"Payment requests"} />}
          </h1>
          {!address && <WalletRequired />}
          {!payment ? (
            <>
              <p className="muted">
                {
                  <UiText
                    text={
                      "Create a signed request. Both wallets must be linked to Telegram first."
                    }
                  />
                }
              </p>
              <Link href="/telegram" className="text-button">
                {<UiText text={"Link a wallet to Telegram"} />}
              </Link>
              {address && (
                <div className="account-details">
                  <span className="detail-label">
                    {<UiText text={"Receiving wallet"} />}
                  </span>
                  <CopyValue value={address} />
                </div>
              )}
              <div style={{ marginTop: 24 }}>
                <label htmlFor="payer" className="detail-label">
                  {<UiText text={"Payer wallet address"} />}
                </label>
                <UiInput
                  id="payer"
                  value={payer}
                  disabled={busy}
                  spellCheck={false}
                  onChange={(e) => {
                    setPayer(e.target.value);
                    setChallenge(null);
                  }}
                  style={inputStyle}
                />
                <label htmlFor="amount" className="detail-label">
                  {<UiText text={"Amount in RTM"} />}
                </label>
                <UiInput
                  id="amount"
                  value={amount}
                  disabled={busy}
                  inputMode="decimal"
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setChallenge(null);
                  }}
                  style={inputStyle}
                />
                <label htmlFor="description" className="detail-label">
                  {<UiText text={"Description"} />}
                </label>
                <UiInput
                  id="description"
                  autoComplete="off"
                  value={description}
                  disabled={busy}
                  maxLength={200}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    setChallenge(null);
                  }}
                  style={inputStyle}
                />
              </div>
              <div className="hero-actions">
                <button
                  className="button secondary"
                  disabled={busy || !address}
                  onClick={prepare}
                >
                  {<UiText text={"1. Prepare request"} />}
                </button>
                <button
                  className="button primary"
                  disabled={busy || !challenge}
                  onClick={create}
                >
                  {<UiText text={"2. Sign and create"} />}
                </button>
              </div>
              <p className="muted">
                {<UiText text={"Creating a request does not transfer RTM."} />}
              </p>
            </>
          ) : (
            <>
              <span className="tag">
                {payment.status === "paid" ? (
                  <UiText text={"Paid - HardFinal"} />
                ) : payment.status === "processing" ? (
                  <UiText text={"Checking transaction - not confirmed"} />
                ) : (
                  <UiText text={"Requested - not paid"} />
                )}
              </span>
              <h2 style={{ marginTop: 24 }}>
                {payment.amountRtm}
                {<UiText text={" RTM"} />}
              </h2>
              <p>{payment.description}</p>
              <div className="account-details">
                <span className="detail-label">
                  {<UiText text={"Recipient"} />}
                </span>
                <CopyValue value={payment.recipient} compact />
                <span className="detail-label">
                  {<UiText text={"Requested payer"} />}
                </span>
                <MemberIdentity
                  nickname={payment.payerLabel}
                  telegram={payment.payerTelegram}
                  address={payment.payer}
                />
                <span className="detail-label">
                  {<UiText text={"Request ID"} />}
                </span>
                <code style={codeStyle}>{payment.id}</code>
                {payment.txId && (
                  <>
                    <span className="detail-label">
                      {<UiText text={"Transaction ID"} />}
                    </span>
                    <CopyValue value={payment.txId} />
                  </>
                )}
              </div>
              <p className="muted">
                {<UiText text={"Request notification: "} />}
                {
                  <UiText
                    text={
                      payment.notification === "unlinked"
                        ? "Telegram not linked (optional)"
                        : payment.notification === "disabled"
                          ? "Payment link only — Telegram is optional"
                          : payment.notification
                    }
                  />
                }
              </p>
              {delivery.length > 0 && (
                <p className="muted">
                  {<UiText text={"Payment confirmations: "} />}
                  {delivery.join(", ")}
                </p>
              )}
              {payment.paymentError && (
                <div className="notice">
                  {payment.paymentError}
                  {<UiText text={" Do not send again."} />}
                </div>
              )}
              <div className="account-details">
                <span className="detail-label">
                  {
                    <UiText
                      text={
                        "Share link (localhost works on this computer only)"
                      }
                    />
                  }
                </span>
                <code style={codeStyle}>{shareUrl}</code>
              </div>
              <div className="hero-actions">
                <button className="button secondary" onClick={copyLink}>
                  {<UiText text={"Copy request link"} />}
                </button>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => {
                    setPayment(null);
                    setChallenge(null);
                    setPayChallenge(null);
                    setNotice("");
                    setRecoveryTx("");
                    setDelivery([]);
                    setReadyToSend(false);
                    sendAllowed.current = false;
                    window.history.replaceState(null, "", "/payments");
                  }}
                >
                  {<UiText text={"New request"} />}
                </button>
              </div>
              {payment.status !== "paid" && (
                <>
                  {payment.recipient === payment.payer ? (
                    <div className="notice">
                      {
                        <UiText
                          text={
                            "This is a self-request for notification testing. Create a new request with two different wallets to pay."
                          }
                        />
                      }
                    </div>
                  ) : (
                    <>
                      <h3 style={{ marginTop: 30 }}>
                        {<UiText text={"Pay from the requested wallet"} />}
                      </h3>
                      <p className="muted">
                        {
                          <UiText
                            text={
                              "The Wallet shows the transfer and network fee separately. Once the TX is saved, the payments worker can continue checking after you close this tab. The worker and local server must stay running."
                            }
                          />
                        }
                      </p>
                      {address && (
                        <p style={codeStyle}>
                          {<UiText text={"Connected: "} />}
                          {address}
                        </p>
                      )}
                      {address !== payment.payer && (
                        <div className="notice" role="status">
                          <strong>
                            <UiText
                              text={
                                address
                                  ? "Wrong payer wallet"
                                  : "Connect the payer wallet"
                              }
                            />
                          </strong>
                          <p>
                            <UiText text="This request can only be paid from the requested wallet:" />{" "}
                            <CopyValue value={payment.payer} compact />
                          </p>
                          <Link className="button secondary" href="/">
                            <UiText text="Change wallet on Dashboard" />
                          </Link>
                          <p>
                            <UiText text="After changing wallets, reopen this request link. No payment has been sent by this page." />
                          </p>
                        </div>
                      )}
                      {address === payment.payer && (
                        <p className="muted">
                          <UiText
                            text={
                              readyToSend
                                ? "Wallet verified. Next: Pay, then approve the transfer in your wallet."
                                : payChallenge
                                  ? "Next: Sign as payer. This signature does not transfer funds."
                                  : "Next: Prepare payer verification to start."
                            }
                          />
                        </p>
                      )}
                      <div className="hero-actions">
                        <button
                          className="button secondary"
                          disabled={
                            busy ||
                            readyToSend ||
                            !address ||
                            address !== payment.payer
                          }
                          onClick={preparePay}
                        >
                          {<UiText text={"1. Prepare payer verification"} />}
                        </button>
                        <button
                          className="button secondary"
                          disabled={
                            busy || !payChallenge || address !== payment.payer
                          }
                          onClick={authorizePay}
                        >
                          {<UiText text={"2. Sign as payer"} />}
                        </button>
                        <button
                          className="button primary"
                          disabled={
                            busy || !readyToSend || address !== payment.payer
                          }
                          onClick={send}
                        >
                          {<UiText text={"3. Pay "} />}
                          {payment.amountRtm}
                          {<UiText text={" RTM"} />}
                        </button>
                      </div>
                      {payment.paymentPhase !== "unpaid" && !readyToSend && (
                        <>
                          <p className="muted">
                            {
                              <UiText
                                text={
                                  "An attempt exists. If you refreshed or lost the response, verify the payer again and check its TX. Sending is not automatically re-enabled."
                                }
                              />
                            }
                          </p>
                          <label htmlFor="recovery" className="detail-label">
                            {
                              <UiText
                                text={
                                  "Existing transfer TX ID from Wallet history"
                                }
                              />
                            }
                          </label>
                          <UiInput
                            id="recovery"
                            value={recoveryTx}
                            disabled={busy}
                            spellCheck={false}
                            placeholder="tx_..."
                            onChange={(e) => setRecoveryTx(e.target.value)}
                            style={inputStyle}
                          />
                          <div className="hero-actions">
                            <button
                              className="button secondary"
                              disabled={
                                busy ||
                                !/^tx_[0-9a-f]{32}$/.test(recoveryTx.trim())
                              }
                              onClick={() => void checkPayment(true)}
                            >
                              {<UiText text={"Attach existing TX and check"} />}
                            </button>
                            <button
                              className="button secondary"
                              disabled={busy}
                              onClick={() => void checkPayment(false)}
                            >
                              {<UiText text={"Check status"} />}
                            </button>
                          </div>
                        </>
                      )}
                    </>
                  )}
                </>
              )}
              {payment.status === "paid" && (
                <p className="muted">
                  {
                    <UiText
                      text={
                        "Verified on-chain as a direct RTM transfer. No further payment is needed."
                      }
                    />
                  }
                </p>
              )}
            </>
          )}
          {notice && (
            <div className="notice" role="status" style={{ marginTop: 20 }}>
              {<UiText text={notice} />}
            </div>
          )}
        </section>
      </main>
    </>
  );
}
