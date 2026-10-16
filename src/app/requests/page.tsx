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
  const { account } = useSharedWallet();
  const address = account?.address || "";
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [verified, setVerified] = useState(false);
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
          status,
          page: String(page),
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
    if (!address) return;
    const controller = new AbortController();
    fetch("/api/payments?action=session", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((session) => {
        if (
          !controller.signal.aborted &&
          session.address === address &&
          session.expiresAt > Date.now()
        ) {
          setExpiresAt(session.expiresAt);
          setVerified(true);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [address]);
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
          <p className="eyebrow">{<UiText text={"RETIUM TESTNET"} />}</p>
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
            {!address && <WalletRequired />}
            {address && !verified && (
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
                {<UiText text={"Sign out of list"} />}
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
              {list && (
                <p className="muted" style={{ marginTop: 20 }}>
                  {<UiText text={"Background monitor:"} />}{" "}
                  {list.worker?.online ? (
                    <UiText text={"running"} />
                  ) : (
                    <UiText text={"offline or not started"} />
                  )}
                  {<UiText text={". Refresh list to update this indicator."} />}
                </p>
              )}
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
                    <div
                      className="account-details"
                      key={String(name)}
                      style={{ margin: 0 }}
                    >
                      <span className="detail-label">
                        {<UiText text={name} />}
                      </span>
                      <strong style={{ fontSize: 26 }}>{count}</strong>
                    </div>
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
                        {bill.description} · {bill.paid}/{bill.count}{" "}
                        <UiText text="Paid" />
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
