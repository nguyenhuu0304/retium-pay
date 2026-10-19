"use client";
import {
  MemberIdentity,
  type TelegramName,
} from "../../components/member-identity";
import { splitFormat } from "../../lib/payments/split";
import { CopyValue } from "../../components/copy-value";
import { UiText } from "../../components/preferences";

import {
  useSharedWallet,
  WalletRequired,
} from "../../components/shared-wallet";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type Provider = {
  request(input: {
    method: string;
    params?: Record<string, unknown>;
  }): Promise<unknown>;
};
type Challenge = { nonce: string; statement: string };
type Signature = {
  address: string;
  message: string;
  signature: string;
  publicKey: string;
};
type Item = {
  id: string;
  recipient: string;
  payer: string;
  amountRtm: string;
  description: string;
  createdAt: number;
  status: string;
  paymentPhase: string;
  txId?: string;
  notification: string;
  paidNotifications: string[];
};
type List = {
  splitBills?: {
    id: string;
    description: string;
    totalAtomic: string;
    paidAtomic: string;
    paid: number;
    count: number;
    members: {
      id: string;
      payer: string;
      payerLabel?: string;
      payerTelegram?: TelegramName;
      amountRtm: string;
      status: string;
      notification: string;
    }[];
  }[];
  address: string;
  expiresAt: number;
  total: number;
  page: number;
  pages: number;
  summary: {
    total: number;
    created: number;
    payable: number;
    paid: number;
    unpaid: number;
    review: number;
  };
  requests: Item[];
  worker?: {
    online: boolean;
    lastSeenAt: number | null;
    lastSuccessAt: number | null;
  };
};
class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function post<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch("/api/payments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(data.error || "Request failed.", response.status);
  return data;
}
function wallet() {
  return (window as unknown as { retium?: Provider }).retium;
}
function errorText(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String(error.code) === "4001"
  )
    return "Signing cancelled. No payment was made.";
  return error instanceof Error
    ? error.message
    : "Could not complete the request.";
}
function short(value: string) {
  return `${value.slice(0, 12)}...${value.slice(-8)}`;
}
function time(value: number) {
  return Number.isFinite(value) ? new Date(value).toLocaleString("en-GB") : "-";
}
function label(item: Item) {
  if (item.status === "paid") return "Paid - HardFinal";
  if (item.paymentPhase === "unknown") return "Needs review";
  if (item.status === "processing") return "Checking TX";
  if (item.paymentPhase === "reserved") return "Attempt reserved";
  return "Requested - not paid";
}
const selectStyle = {
  padding: "10px 12px",
  background: "#101114",
  border: "1px solid #383b45",
  borderRadius: 9,
  color: "white",
  minWidth: 180,
};
const cellStyle = {
  padding: "16px 12px",
  borderBottom: "1px solid #30333b",
  verticalAlign: "top" as const,
};

export default function RequestsPage() {
  const { account, ready } = useSharedWallet();
  const address = account?.address || "";
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [verified, setVerified] = useState(false);
  const [checkedAddress, setCheckedAddress] = useState("");
  const [restoreError, setRestoreError] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [noticeBusy, setNoticeBusy] = useState("");
  const [expiresAt, setExpiresAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [role, setRole] = useState("all");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [list, setList] = useState<List | null>(null);
  const lock = useRef(false);

  useEffect(() => {
    if (!verified || !address) return;
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      try {
        const query = new URLSearchParams({
          action: "list",
          role,
          status: status === "unpaid" ? "all" : status,
          page: status === "unpaid" ? "1" : String(page),
        });
        const response = await fetch(`/api/payments?${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok)
          throw new ApiError(
            data.error || "Could not load requests.",
            response.status,
          );
        if (data.address !== address)
          throw new ApiError(
            "The verified session belongs to another wallet. Verify the connected wallet again.",
            401,
          );
        if (status === "unpaid") {
          // Existing API has no aggregate unpaid filter. Read its complete authorized list,
          // then filter before paginating so processing/review requests are not omitted.
          if (!Number.isSafeInteger(data.pages) || data.pages > 200) throw Error("Too many requests for this filter. Select a specific status.");
          const rows: Item[] = [...data.requests];
          for (let next = 2; next <= data.pages; next++) {
            query.set("page", String(next));
            const response = await fetch(`/api/payments?${query}`, { cache: "no-store", signal: controller.signal });
            const more = await response.json();
            if (!response.ok || more.address !== address || !Array.isArray(more.requests)) throw new ApiError("Could not load the complete unpaid list.", response.status);
            rows.push(...more.requests);
          }
          const unique = [...new Map(rows.map((item) => [item.id, item])).values()].filter((item) => item.status !== "paid");
          data.total = unique.length;
          data.pages = Math.max(1, Math.ceil(unique.length / 20));
          data.page = Math.min(page, data.pages);
          data.requests = unique.slice((data.page - 1) * 20, data.page * 20);
        }
        if (!controller.signal.aborted) {
          setList(data);
          setExpiresAt(data.expiresAt);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setNotice(errorText(error));
        if (error instanceof ApiError && error.status === 401) {
          setVerified(false);
          setList(null);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [address, verified, role, status, page, refresh]);

  useEffect(() => {
    if (!verified || !expiresAt) return;
    const timer = setTimeout(
      () => {
        setVerified(false);
        setList(null);
        setChallenge(null);
        setNotice("Your viewing session expired. Verify the wallet again.");
      },
      Math.max(0, expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [verified, expiresAt]);

  useEffect(() => {
    if (!address || !ready) return;
    const controller = new AbortController();
    async function restore() {
      try {
        const response = await fetch("/api/payments?action=session", {
          cache: "no-store", credentials: "same-origin", signal: controller.signal,
        });
        if (!response.ok) throw Error("Session unavailable");
        const session = await response.json();
        if (controller.signal.aborted) return;
        const valid = session.address === address && session.expiresAt > Date.now();
        setVerified(valid);
        if (valid) setExpiresAt(session.expiresAt);
        setRestoreError(false);
        setCheckedAddress(address);
      } catch {
        if (!controller.signal.aborted) setRestoreError(true);
      }
    }
    void restore();
    return () => controller.abort();
  }, [address, ready, restoreAttempt]);
  async function sendNotice(member: { id: string; notification: string }) {
    if (lock.current) return;
    lock.current = true;
    setNoticeBusy(member.id);
    try {
      const result = await post<{ payment: { notification: string } }>({
        action: "sendSplitNotification", id: member.id, enable: true,
      });
      setNotice(result.payment.notification === "sent" ? "Telegram sent to the payer." : "Telegram delivery not confirmed. Check the payer's Telegram before retrying.");
      setRefresh((n) => n + 1);
    } catch (error) { setNotice(errorText(error)); }
    finally { setNoticeBusy(""); lock.current = false; }
  }
  async function prepare() {
    if (!address || lock.current) return;
    lock.current = true;
    setBusy(true);
    setChallenge(null);
    setNotice("");
    try {
      const data = await post<Challenge>({ action: "prepareList", address });
      setChallenge({ nonce: data.nonce, statement: data.statement });
      setNotice(
        "Ready to sign. This only opens your request list; it does not transfer funds.",
      );
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function sign() {
    const provider = wallet();
    if (!provider || !challenge || lock.current) return;
    lock.current = true;
    setBusy(true);
    setNotice("");
    try {
      const result = (await provider.request({
        method: "retium_signAuth",
        params: challenge,
      })) as Signature;
      const session = await post<{ address: string; expiresAt: number }>({
        action: "verifyList",
        ...result,
      });
      if (session.address !== address)
        throw new Error("Connected account changed. Connect and verify again.");
      setExpiresAt(session.expiresAt);
      setVerified(true);
      setChallenge(null);
      setPage(1);
      setNotice("Wallet verified. Viewing requests for this wallet only.");
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function logout() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setVerified(false);
    setList(null);
    setChallenge(null);
    setNotice("");
    try {
      await post({ action: "logoutList" });
      setExpiresAt(0);
      setNotice("Viewing session signed out.");
    } catch (error) {
      setNotice(
        `Sign-out was not confirmed. Please retry. ${errorText(error)}`,
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <main
        className="app-shell"
        style={{ maxWidth: 1200, paddingTop: 40, paddingBottom: 40 }}
      >
        <section className="wallet-card" style={{ marginTop: 25 }}>
          <p className="eyebrow">{<UiText text={"RETIUM PAY · TESTNET"} />}</p>
          <h1 style={{ fontSize: 38 }}>{<UiText text={"My History"} />}</h1>
          <p className="muted">
            {
              <UiText
                text={
                  "Requests you created and requests addressed to your wallet. Newest first. Viewing the list does not send RTM."
                }
              />
            }
          </p>
          <div className="hero-actions">
            {!ready && <UiText text="Restoring wallet…" />}
            {ready && !address && <WalletRequired />}
            {address && checkedAddress !== address && !restoreError && <UiText text="Restoring History session…" />}
            {address && restoreError && <><UiText text="Could not restore the viewing session." /><button className="button secondary" onClick={() => { setRestoreError(false); setRestoreAttempt((n) => n + 1); }}><UiText text="Retry session check" /></button></>}
            {address && checkedAddress === address && !restoreError && !verified && (
              <>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={prepare}
                >
                  {<UiText text={"1. Prepare verification"} />}
                </button>
                <button
                  className="button primary"
                  disabled={busy || !challenge}
                  onClick={sign}
                >
                  {<UiText text={"2. Sign to view"} />}
                </button>
              </>
            )}
            {address && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={logout}
              >
                {<UiText text={"Lock private history"} />}
              </button>
            )}
          </div>
          {address && (
            <div className="account-details">
              <span className="detail-label">
                {verified ? (
                  <UiText text={"Verified wallet"} />
                ) : (
                  <UiText text={"Connected wallet - verification required"} />
                )}
              </span>
              <CopyValue value={address} />
            </div>
          )}
          {notice && (
            <div className="notice" role="status" style={{ marginTop: 20 }}>
              {<UiText text={notice} />}
            </div>
          )}
          {verified && (
            <>
              {list && <div className="history-health"><span className={list.worker?.online ? "readiness good" : "readiness warning"}><span className="connection-dot" /><UiText text={list.worker?.online ? "Live updates on" : "Live updates unavailable"} /></span><button className="button secondary" disabled={busy || loading} onClick={() => setRefresh((n) => n + 1)}><UiText text="Refresh" /></button></div>}
              {list && (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(125px, 1fr))",
                    gap: 12,
                    marginTop: 24,
                  }}
                >
                  {[
                    ["All requests", list.summary.total],
                    ["Created by me", list.summary.created],
                    ["Addressed to me", list.summary.payable],
                    ["Paid", list.summary.paid],
                    ["Not paid", list.summary.unpaid],
                    ["Needs review", list.summary.review],
                  ].map(([name, count]) => (
                    <button
                      type="button"
                      aria-pressed={name === "Created by me" ? role === "created" : name === "Addressed to me" ? role === "payable" : name === "Paid" ? status === "paid" : name === "Not paid" ? status === "unpaid" : name === "Needs review" ? status === "review" : role === "all" && status === "all"}
                      onClick={() => {
                        setRole(name === "Created by me" ? "created" : name === "Addressed to me" ? "payable" : "all");
                        setStatus(name === "Paid" ? "paid" : name === "Not paid" ? "unpaid" : name === "Needs review" ? "review" : "all");
                        setPage(1);
                      }}
                      className="account-details history-stat"
                      key={String(name)}
                      style={{ margin: 0 }}
                    >
                      <span className="detail-label">
                        {<UiText text={name} />}
                      </span>
                      <strong style={{ fontSize: 26 }}>{count}</strong>
                    </button>
                  ))}
                </div>
              )}
              {!!list?.splitBills?.length && (
                <section style={{ marginTop: 20 }}>
                  <h2>
                    <UiText text="My split bills" />
                  </h2>
                  {list.splitBills.map((bill) => (
                    <details
                      key={bill.id}
                      className="account-details"
                      style={{ marginBottom: 12 }}
                    >
                      <summary>
                        <span>{bill.description.replace(/^\[Bill [^\]]+\]\s*/, "").trim() || "Split Bill"}</span>
                        <span className={bill.paid === bill.count ? "readiness good" : "readiness warning"}>{bill.paid}/{bill.count} <UiText text="Paid" /></span>
                        <span>{splitFormat(BigInt(bill.totalAtomic))} RTM</span>
                      </summary>
                      <p>
                        <UiText text="Collected" />:{" "}
                        {splitFormat(BigInt(bill.paidAtomic))} /{" "}
                        {splitFormat(BigInt(bill.totalAtomic))} RTM ·{" "}
                        <UiText text="Remaining" />:{" "}
                        {splitFormat(
                          BigInt(bill.totalAtomic) - BigInt(bill.paidAtomic),
                        )}{" "}
                        RTM
                      </p>
                      {bill.members.map((member) => (
                        <p key={member.id}>
                          <MemberIdentity
                            nickname={member.payerLabel}
                            telegram={member.payerTelegram}
                            address={member.payer}
                          />{" "}
                          · {member.amountRtm} RTM ·{" "}
                          <UiText
                            text={
                              member.status === "paid" ? "Paid" : "Not paid"
                            }
                          />{" "}
                          ·{" "}
                          <Link href={`/payments?id=${member.id}`}>
                            <UiText text="Open payment request" />
                          </Link>
                          <span style={{ display: "block", marginTop: 8 }}>
                            <UiText text="Telegram" />: <UiText text={member.notification === "sent" ? "Sent to payer" : member.notification === "disabled" ? "Disabled" : member.notification === "unlinked" ? "Payer not linked" : member.notification === "sending" ? "Sending — check Telegram" : member.notification === "unknown" ? "Delivery uncertain — check Telegram" : "Not sent"} />
                            {member.status !== "paid" && !["sent", "sending", "unknown"].includes(member.notification) && (
                              <button type="button" className="button secondary" style={{ marginLeft: 10 }} disabled={!!noticeBusy} onClick={() => void sendNotice(member)}>
                                <UiText text={noticeBusy === member.id ? "Sending…" : member.notification === "disabled" ? "Enable and send Telegram" : "Send Telegram notification"} />
                              </button>
                            )}
                          </span>
                        </p>
                      ))}
                    </details>
                  ))}
                </section>
              )}
              <div
                style={{
                  display: "flex",
                  gap: 14,
                  flexWrap: "wrap",
                  alignItems: "end",
                  marginTop: 25,
                }}
              >
                <label>
                  <span
                    className="detail-label"
                    style={{ display: "block", marginBottom: 6 }}
                  >
                    {<UiText text={"Role"} />}
                  </span>
                  <select
                    style={selectStyle}
                    value={role}
                    disabled={busy || loading}
                    onChange={(e) => {
                      setRole(e.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="all">
                      {<UiText text={"All related requests"} />}
                    </option>
                    <option value="created">
                      {<UiText text={"Created by me"} />}
                    </option>
                    <option value="payable">
                      {<UiText text={"Addressed to me"} />}
                    </option>
                  </select>
                </label>
                <label>
                  <span
                    className="detail-label"
                    style={{ display: "block", marginBottom: 6 }}
                  >
                    {<UiText text={"Status"} />}
                  </span>
                  <select
                    style={selectStyle}
                    value={status}
                    disabled={busy || loading}
                    onChange={(e) => {
                      setStatus(e.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="all">
                      {<UiText text={"All statuses"} />}
                    </option>
                    <option value="unpaid"><UiText text="Not paid" /></option>
                    <option value="requested">
                      {<UiText text={"Requested"} />}
                    </option>
                    <option value="processing">
                      {<UiText text={"Checking TX"} />}
                    </option>
                    <option value="paid">{<UiText text={"Paid"} />}</option>
                    <option value="review">
                      {<UiText text={"Needs review"} />}
                    </option>
                  </select>
                </label>
                <button
                  className="button secondary"
                  disabled={busy || loading}
                  onClick={() => {
                    setNotice("");
                    setRefresh((v) => v + 1);
                  }}
                >
                  {<UiText text={"Refresh list"} />}
                </button>
              </div>
              <p className="muted" style={{ marginTop: 16 }}>
                {loading ? (
                  <UiText text={"Loading requests..."} />
                ) : (
                  `${list?.total ?? 0} matching requests. Times use your browser timezone.`
                )}
              </p>
              {list && (
                <>
                  <div style={{ overflowX: "auto" }}>
                    <table
                      style={{
                        width: "100%",
                        borderCollapse: "collapse",
                        minWidth: 730,
                        textAlign: "left",
                      }}
                    >
                      <thead>
                        <tr>
                          {[
                            "Created / description",
                            "My role / counterparty",
                            "Amount",
                            "Status",
                            "Details",
                          ].map((text) => (
                            <th key={text} style={cellStyle}>
                              {text}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {list.requests.map((item) => {
                          const created = item.recipient === address;
                          const self = item.recipient === item.payer;
                          const counterparty = created
                            ? item.payer
                            : item.recipient;
                          return (
                            <tr key={item.id}>
                              <td style={cellStyle}>
                                <strong>{item.description}</strong>
                                <div className="muted" style={{ marginTop: 6 }}>
                                  {time(item.createdAt)}
                                </div>
                                <code title={item.id}>{short(item.id)}</code>
                              </td>
                              <td style={cellStyle}>
                                <div>
                                  {self ? (
                                    <UiText
                                      text={"Created + addressed to me"}
                                    />
                                  ) : created ? (
                                    <UiText text={"Created by me"} />
                                  ) : (
                                    <UiText text={"Addressed to me"} />
                                  )}
                                </div>
                                <span className="detail-label">
                                  {created ? (
                                    <UiText text={"Payer"} />
                                  ) : (
                                    <UiText text={"Recipient"} />
                                  )}
                                </span>
                                <CopyValue value={counterparty} />
                              </td>
                              <td
                                style={{ ...cellStyle, whiteSpace: "nowrap" }}
                              >
                                {item.amountRtm}
                                {<UiText text={" RTM"} />}
                              </td>
                              <td style={cellStyle}>
                                <span
                                  className="tag"
                                  style={
                                    item.status === "paid"
                                      ? {
                                          color: "#84e4ae",
                                          borderColor: "#377b50",
                                        }
                                      : {}
                                  }
                                >
                                  {<UiText text={label(item)} />}
                                </span>
                                <div className="muted" style={{ marginTop: 8 }}>
                                  {<UiText text={"Request notice: "} />}
                                  {<UiText text={item.notification} />}
                                </div>
                                {item.paidNotifications.length > 0 && (
                                  <div className="muted">
                                    {<UiText text={"Paid notices:"} />}{" "}
                                    {item.paidNotifications.join(", ")}
                                  </div>
                                )}
                              </td>
                              <td style={cellStyle}>
                                <Link
                                  className="text-button"
                                  href={`/payments?id=${item.id}`}
                                >
                                  {<UiText text={"Open request"} />}
                                </Link>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {!loading && list.requests.length === 0 && (
                    <p className="muted" style={{ padding: 20 }}>
                      {<UiText text={"No requests match these filters."} />}
                    </p>
                  )}
                  <div
                    className="hero-actions"
                    style={{ alignItems: "center" }}
                  >
                    <button
                      className="button secondary"
                      disabled={busy || loading || list.page <= 1}
                      onClick={() => setPage(list.page - 1)}
                    >
                      {<UiText text={"Previous"} />}
                    </button>
                    <span>
                      {<UiText text={"Page "} />}
                      {list.page} / {list.pages}
                    </span>
                    <button
                      className="button secondary"
                      disabled={busy || loading || list.page >= list.pages}
                      onClick={() => setPage(list.page + 1)}
                    >
                      {<UiText text={"Next"} />}
                    </button>
                  </div>
                </>
              )}
              <p className="muted">
                {
                  <UiText
                    text={
                      "This list contains requests saved by this Retium Pay instance, not your complete on-chain wallet history. The viewing session lasts one hour."
                    }
                  />
                }
              </p>
            </>
          )}
        </section>
      </main>
    </>
  );
}
