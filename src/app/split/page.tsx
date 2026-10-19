"use client";
import {
  MemberIdentity,
  type TelegramName,
} from "../../components/member-identity";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  useSharedWallet,
  WalletRequired,
} from "../../components/shared-wallet";
import { UiInput, UiText } from "../../components/preferences";
import { CopyValue } from "../../components/copy-value";
import { equalShares, splitFormat, splitUnits } from "../../lib/payments/split";
import "./split.css";
type Registered = {
  userId: string;
  address: string;
  displayName: string;
  username: string;
};
type Contact = {
  address: string;
  nickname: string;
  displayName: string;
  username: string;
  linked: boolean;
};
type Member = {
  payer: string;
  amount: string;
  name?: string;
  telegram?: string;
};
type Payment = {
  recipient?: string;
  id: string;
  payer: string;
  payerLabel?: string;
  payerTelegram?: TelegramName;
  amountRtm: string;
  notification: string;
  splitBillId: string;
  status: string;
};
type Signature = {
  address: string;
  message: string;
  signature: string;
  publicKey: string;
};
type Draft = {
  nonce: string;
  statement: string;
  payments: Payment[];
  totalAtomic: string;
};
async function post(body: Record<string, unknown>) {
  const response = await fetch("/api/payments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "Request failed.");
  return data;
}
export default function SplitBill() {
  const { account } = useSharedWallet();
  const address = account?.address || "";
  const [members, setMembers] = useState<Member[]>([
    { payer: "", amount: "" },
    { payer: "", amount: "" },
  ]);
  const [mode, setMode] = useState("equal"),
    [total, setTotal] = useState(""),
    [description, setDescription] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null),
    [proof, setProof] = useState<Signature | null>(null),
    [saved, setSaved] = useState<Payment[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [registered, setRegistered] = useState<Registered[]>([]),
    [selectedRegistered, setSelectedRegistered] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]),
    [directoryReady, setDirectoryReady] = useState(false);
  const [loginChallenge, setLoginChallenge] = useState<{
    nonce: string;
    statement: string;
  } | null>(null);
  const [contactCode, setContactCode] = useState(""),
    [nickname, setNickname] = useState(""),
    [editing, setEditing] = useState("");
  useEffect(() => {
    let live = true;
    if (address)
      fetch("/api/payments?action=directory", { cache: "no-store" })
        .then(async (r) => {
          if (!r.ok) return;
          const data = await r.json();
          if (live && data.address === address) {
            setContacts(data.members);
            setRegistered(data.registered || []);
            setDirectoryReady(true);
          }
        })
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [address]);
  useEffect(() => {
    if (!address || !directoryReady) return;
    let live = true,
      pending = false;
    const controller = new AbortController();
    async function sync() {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const r = await fetch("/api/payments?action=directory", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!r.ok) return;
        const data = await r.json();
        if (live && data.address === address) {
          setContacts((previous) =>
            JSON.stringify(previous) === JSON.stringify(data.members)
              ? previous
              : data.members,
          );
          setRegistered((previous) =>
            JSON.stringify(previous) === JSON.stringify(data.registered || [])
              ? previous
              : data.registered || [],
          );
        }
      } catch {
        /* Manual refresh provides an explicit error. */
      } finally {
        pending = false;
      }
    }
    const timer = setInterval(() => void sync(), 30_000);
    const onFocus = () => void sync();
    window.addEventListener("focus", onFocus);
    return () => {
      live = false;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [address, directoryReady]);
  async function refreshDirectory() {
    const response = await fetch("/api/payments?action=directory", {
      cache: "no-store",
    });
    const data = await response.json();
    if (!response.ok || data.address !== address)
      throw Error("Verify your wallet to view your requests.");
    setContacts(data.members);
    setRegistered(data.registered || []);
    setDirectoryReady(true);
  }
  const memberName = (payer: string) => {
    const contact = contacts.find((c) => c.address === payer);
    return contact
      ? `${contact.nickname}${contact.displayName ? ` · ${contact.displayName}` : ""}${contact.username ? ` (@${contact.username})` : ""}`
      : "";
  };
  const journalKey = `retium-pay:split-journal:${address}`;
  const [recovery, setRecovery] = useState<string[]>([]);
  const [journalReady, setJournalReady] = useState(false);
  useEffect(() => {
    let live = true;
    queueMicrotask(() => {
      if (!address || !live) return;
      try {
        const raw = localStorage.getItem(`retium-pay:split-journal:${address}`);
        if (raw) {
          const ids: unknown = JSON.parse(raw);
          if (
            !Array.isArray(ids) ||
            ids.length < 2 ||
            ids.length > 20 ||
            !ids.every(
              (id) => typeof id === "string" && /^[0-9a-f]{48}$/.test(id),
            )
          )
            throw Error("Invalid saved bill recovery data.");
          setRecovery(ids);
        }
        setJournalReady(true);
      } catch {
        setError(
          "Could not read saved bill recovery data. Check My History before creating another bill.",
        );
      }
    });
    return () => {
      live = false;
    };
  }, [address]);
  async function restoreBill() {
    await run(async () => {
      const rows: Payment[] = [];
      for (const id of recovery) {
        const response = await fetch(`/api/payments?id=${id}`, {
          cache: "no-store",
        });
        if (!response.ok)
          throw Error(
            "Bill recovery is not confirmed. Check My History before creating another bill.",
          );
        const data = await response.json();
        if (
          data.payment?.id !== id ||
          data.payment.recipient !== address ||
          (rows.length && data.payment.splitBillId !== rows[0].splitBillId)
        )
          throw Error("Saved bill does not match this wallet.");
        rows.push(data.payment);
      }
      setSaved(rows);
      setRecovery([]);
      setDraft(null);
      setProof(null);
    });
  }
  const [copiedLink, setCopiedLink] = useState("");
  const lock = useRef(false);
  async function run(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function prepare() {
    await run(async () => {
      const shares =
        mode === "equal"
          ? equalShares(total.trim(), members.length)
          : members.map((m) => splitFormat(splitUnits(m.amount.trim())));
      const rows = members.map((m, i) => ({
        payer: m.payer.trim().toLowerCase(),
        amount: shares[i],
        name:
          m.name || contacts.find((c) => c.address === m.payer)?.nickname || "",
        notifyTelegram: !!m.telegram,
      }));
      if (
        rows.some(
          (m) => !/^rete[0-9a-f]{68}$/.test(m.payer) || m.payer === address,
        ) ||
        new Set(rows.map((m) => m.payer)).size !== rows.length
      )
        throw Error(
          "Use distinct payer wallets, different from your receiving wallet.",
        );
      setDraft(
        await post({
          action: "prepareSplit",
          recipient: address,
          description,
          members: rows,
        }),
      );
    });
  }
  async function create() {
    if (!draft || !journalReady) return;
    await run(async () => {
      let signed = proof;
      if (!signed) {
        if (!window.retium)
          throw Error("Open the Dashboard and connect your wallet first.");
        signed = (await window.retium.request({
          method: "retium_signAuth",
          params: { nonce: draft.nonce, statement: draft.statement },
        })) as Signature;
        if (signed.address !== address)
          throw Error("The signing account differs from the Dashboard wallet.");
        setProof(signed);
      }
      localStorage.setItem(
        journalKey,
        JSON.stringify(draft.payments.map((p) => p.id)),
      );
      const result = await post({ action: "create", ...signed });
      if (
        !Array.isArray(result.payments) ||
        result.payments.length !== draft.payments.length ||
        result.payments[0]?.splitBillId !== draft.payments[0]?.splitBillId
      )
        throw Error(
          "Response did not match this bill. Check My History before continuing.",
        );
      setSaved(result.payments);
      setDraft(null);
      setProof(null);
    });
  }
  const frozen = busy || !!draft || saved.length > 0 || recovery.length > 0;
  let equalPreview: string[] = [];
  if (mode === "equal" && total.trim()) {
    try {
      equalPreview = equalShares(total.trim(), members.length);
    } catch {
      /* Review displays validation errors. */
    }
  }
  return (
    <main className="split-shell">
      <p className="split-eyebrow">RETIUM PAY · TESTNET</p>
      <h1>
        <UiText text="Split Bill" />
      </h1>
      {!address && <WalletRequired />}
      <p>
        <UiText text="Create a group bill. Each payer pays directly to your wallet. Telegram notifications are optional." />
      </p>
      <p>
        <UiText text="Add any valid payer wallet. Share payment links manually, or receive notifications through linked Telegram accounts. Your wallet is not counted as a payer." />
      </p>
      {address && (
        <p>
          <UiText text="Receiving wallet" />: <CopyValue value={address} />
        </p>
      )}
      {address && (
        <details className="split-card">
          <summary>
            <UiText text="Add members / Telegram (optional)" /> (
            {contacts.length})
          </summary>
          {!directoryReady ? (
            <>
              <p>
                <UiText text="Verify your wallet to open your private member directory." />
              </p>
              {!loginChallenge ? (
                <button
                  disabled={busy || !!draft}
                  onClick={() =>
                    run(async () => {
                      const data = await post({
                        action: "prepareList",
                        address,
                      });
                      setLoginChallenge({
                        nonce: data.nonce,
                        statement: data.statement,
                      });
                    })
                  }
                >
                  <UiText text="Prepare member sign-in" />
                </button>
              ) : (
                <button
                  disabled={busy || !!draft}
                  onClick={() =>
                    run(async () => {
                      if (!window.retium)
                        throw Error("Connect your wallet on Dashboard first.");
                      const signed = (await window.retium.request({
                        method: "retium_signAuth",
                        params: loginChallenge,
                      })) as Signature;
                      if (signed.address !== address)
                        throw Error(
                          "The signing account differs from the Dashboard wallet.",
                        );
                      await post({ action: "verifyList", ...signed });
                      await refreshDirectory();
                      setLoginChallenge(null);
                    })
                  }
                >
                  <UiText text="Sign to open members" />
                </button>
              )}
            </>
          ) : (
            <>
              <p>
                <UiText text="Members use /contact in RetiumPay_Bot, then appear here automatically. Select a member and set your own nickname. You can also save a wallet without Telegram." />
              </p>
              <a
                href="https://t.me/RetiumPay_Bot"
                target="_blank"
                rel="noopener noreferrer"
              >
                <UiText text="Invite member via Telegram" />
              </a>
              <label>
                <UiText text="Registered Telegram members" />
                <select
                  disabled={busy || !!draft}
                  value={selectedRegistered}
                  onChange={(e) => {
                    const id = e.target.value;
                    setSelectedRegistered(id);
                    setEditing("");
                    setContactCode("");
                    const member = registered.find((c) => c.userId === id);
                    if (member)
                      setNickname(
                        (member.displayName || member.username || "").slice(
                          0,
                          60,
                        ),
                      );
                  }}
                >
                  <option value="">
                    <UiText text="Choose a registered Telegram member" />
                  </option>
                  {registered.map((c) => (
                    <option key={c.userId} value={c.userId}>
                      {c.displayName || c.username || c.address.slice(0, 12)}
                      {c.username ? ` (@${c.username})` : ""} ·{" "}
                      {c.address.slice(0, 10)}…{c.address.slice(-6)}
                    </option>
                  ))}
                </select>
              </label>
              {!registered.length && (
                <p>
                  <UiText text="No registered members yet. Ask a member with a linked wallet to send /contact, then refresh members." />
                </p>
              )}
              <label>
                <UiText text="Or add a wallet without Telegram" />
                <UiInput
                  disabled={busy || !!draft}
                  value={contactCode}
                  onChange={(e) => {
                    setContactCode(e.target.value);
                    setSelectedRegistered("");
                    setEditing("");
                  }}
                  placeholder="rete…"
                  autoComplete="off"
                />
              </label>
              <label>
                <UiText text="My nickname for this member" />
                <UiInput
                  disabled={busy || !!draft}
                  value={nickname}
                  maxLength={60}
                  onChange={(e) => setNickname(e.target.value)}
                />
              </label>
              <button
                disabled={
                  busy ||
                  !!draft ||
                  !nickname ||
                  (!contactCode && !editing && !selectedRegistered)
                }
                onClick={() =>
                  run(async () => {
                    await post({
                      action: "saveContact",
                      ...(selectedRegistered
                        ? { registeredUserId: selectedRegistered }
                        : {}),
                      code: contactCode.trim().startsWith("RP-")
                        ? contactCode.trim()
                        : "",
                      wallet: contactCode.trim().startsWith("RP-")
                        ? ""
                        : contactCode.trim(),
                      memberAddress: editing,
                      nickname,
                    });
                    await refreshDirectory();
                    setContactCode("");
                    setSelectedRegistered("");
                    setNickname("");
                    setEditing("");
                  })
                }
              >
                <UiText
                  text={
                    editing
                      ? "Save nickname"
                      : selectedRegistered
                        ? "Add member"
                        : "Save member"
                  }
                />
              </button>
              <button disabled={busy} onClick={() => run(refreshDirectory)}>
                <UiText text="Refresh members" />
              </button>
              {contacts.map((c) => (
                <div key={c.address} className="split-contact">
                  <MemberIdentity
                    nickname={c.nickname}
                    telegram={{
                      displayName: c.displayName,
                      username: c.username,
                    }}
                    address={c.address}
                  />
                  {!c.linked && (
                    <UiText text="Telegram not linked (optional)" />
                  )}
                  <br />
                  <button
                    disabled={busy || !!draft}
                    onClick={() => {
                      setEditing(c.address);
                      setSelectedRegistered("");
                      setNickname(c.nickname);
                      setContactCode("");
                    }}
                  >
                    <UiText text="Edit nickname" />
                  </button>
                  <button
                    disabled={busy || !!draft}
                    onClick={() =>
                      run(async () => {
                        await post({
                          action: "removeContact",
                          memberAddress: c.address,
                        });
                        await refreshDirectory();
                      })
                    }
                  >
                    <UiText text="Remove member" />
                  </button>
                </div>
              ))}
            </>
          )}
        </details>
      )}
      {!!recovery.length && (
        <section className="split-card">
          <h2>
            <UiText text="Restore your last bill" />
          </h2>
          <p>
            <UiText text="A bill creation was saved in this browser. Restore it before creating another bill. This does not send a payment or Telegram message." />
          </p>
          <button disabled={busy} onClick={restoreBill}>
            <UiText text="Restore saved bill" />
          </button>
          <Link href="/requests">
            <UiText text="My History" />
          </Link>
          <button
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  "Have you checked My History and confirmed you want to clear this browser recovery record? This does not delete any saved bill.",
                )
              ) {
                localStorage.removeItem(journalKey);
                setRecovery([]);
              }
            }}
          >
            <UiText text="I checked history — clear recovery" />
          </button>
        </section>
      )}
      {!saved.length && !recovery.length && !draft && (
        <section className="split-card">
          <fieldset disabled={frozen}>
            <label>
              <UiText text="Bill description" />
              <UiInput
                value={description}
                maxLength={140}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Bill description"
              />
            </label>
            <label>
              <UiText text="Split mode" />
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="equal"><UiText text="Equal" /></option>
                <option value="custom">Custom / Tùy chỉnh</option>
              </select>
            </label>
            {mode === "equal" && (
              <label>
                <UiText text="Total RTM to collect" />
                <UiInput
                  value={total}
                  inputMode="decimal"
                  onChange={(e) => setTotal(e.target.value)}
                  placeholder="Amount in RTM"
                />
              </label>
            )}
            <label>
              <UiText text="People (2–20)" />
              <UiInput
                type="number"
                min={2}
                max={20}
                value={members.length}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isInteger(n) && n >= 2 && n <= 20)
                    setMembers(
                      Array.from(
                        { length: n },
                        (_, i) =>
                          members[i] || {
                            payer: "",
                            amount: "",
                            name: "",
                            telegram: "",
                          },
                      ),
                    );
                }}
              />
            </label>
            <div className="split-people-grid">
              {members.map((member, i) => (
                <div className="split-person" key={i}>
                  <label>
                    <UiText text="Person" /> {i + 1}
                    <UiInput
                      value={member.name || ""}
                      placeholder="Name / nickname"
                      maxLength={60}
                      list="split-saved-names"
                      onChange={(e) => {
                        const name = e.target.value;
                        const found = contacts.find((c) => c.nickname === name);
                        setMembers(
                          members.map((m, j) =>
                            j === i
                              ? {
                                  ...m,
                                  name,
                                  ...(found
                                    ? { payer: found.address, telegram: "" }
                                    : {}),
                                }
                              : m,
                          ),
                        );
                      }}
                    />
                  </label>
                  <label>
                    <UiText text="Telegram member (optional)" />
                    <select
                      value={member.telegram || ""}
                      onChange={(e) => {
                        const selected = contacts.find(
                          (c) => c.address === e.target.value,
                        );
                        setMembers(
                          members.map((m, j) =>
                            j === i
                              ? {
                                  ...m,
                                  telegram: selected?.address || "",
                                  ...(selected
                                    ? {
                                        payer: selected.address,
                                        name: selected.nickname,
                                      }
                                    : {}),
                                }
                              : m,
                          ),
                        );
                      }}
                    >
                      <option value="">
                        <UiText text="No Telegram — payment link only" />
                      </option>
                      {contacts
                        .filter((c) => c.linked)
                        .map((c) => (
                          <option
                            key={c.address}
                            value={c.address}
                            disabled={members.some(
                              (m, j) => j !== i && m.payer === c.address,
                            )}
                          >
                            {memberName(c.address)}
                          </option>
                        ))}
                    </select>
                  </label>
                  {equalPreview[i] && (
                    <p>
                      <UiText text="Amount to pay" />:{" "}
                      <strong>{equalPreview[i]} RTM</strong>
                    </p>
                  )}
                  <small>
                    <UiText
                      text={
                        member.telegram
                          ? "Telegram notification enabled"
                          : "Payment link only — Telegram is optional"
                      }
                    />
                  </small>
                  <label>
                    <UiText text="Payer wallet" />
                    <UiInput
                      value={member.payer}
                      onChange={(e) =>
                        setMembers(
                          members.map((m, j) =>
                            j === i
                              ? { ...m, payer: e.target.value, telegram: "" }
                              : m,
                          ),
                        )
                      }
                      placeholder="rete…"
                    />
                  </label>
                  {mode === "custom" && (
                    <label>
                      RTM
                      <UiInput
                        inputMode="decimal"
                        value={member.amount}
                        onChange={(e) =>
                          setMembers(
                            members.map((m, j) =>
                              j === i ? { ...m, amount: e.target.value } : m,
                            ),
                          )
                        }
                      />
                    </label>
                  )}
                  <button
                    type="button"
                    disabled={members.length <= 2}
                    onClick={() =>
                      setMembers(members.filter((_, j) => j !== i))
                    }
                  >
                    <UiText text="Remove" />
                  </button>
                  {members.length <= 2 && (
                    <small>
                      <UiText text="Minimum 2 payers — Remove is unavailable" />
                    </small>
                  )}
                </div>
              ))}
            </div>
            {mode === "equal" && equalPreview.length > 0 && (
              <p className="split-total">
                <UiText text="Total" />:{" "}
                <strong>
                  {splitFormat(
                    equalPreview.reduce(
                      (n, amount) => n + splitUnits(amount),
                      0n,
                    ),
                  )}{" "}
                  RTM
                </strong>{" "}
                · {members.length} <UiText text="payers" />
              </p>
            )}
            <datalist id="split-saved-names">
              {contacts.map((c) => (
                <option key={c.address} value={c.nickname}>
                  {memberName(c.address)}
                </option>
              ))}
            </datalist>

            {members.length === 2 && (
              <p className="split-hint">
                <UiText text="Split Bill requires at least 2 payers. For one payer, use Payments." />
              </p>
            )}
            <button
              type="button"
              disabled={members.length >= 20}
              onClick={() =>
                setMembers([...members, { payer: "", amount: "" }])
              }
            >
              <UiText text="Add payer" />
            </button>
          </fieldset>
          {!draft && (
            <button
              disabled={busy || !address || !journalReady}
              onClick={prepare}
            >
              <UiText text={busy ? "Working…" : "Review bill"} />
            </button>
          )}
        </section>
      )}
      {draft && (
        <section className="split-card">
          <h2>
            <UiText text="Review bill" />
          </h2>
          <p>{description}</p>
          <p>
            <UiText text="Total RTM to collect" />:{" "}
            <b>{splitFormat(BigInt(draft.totalAtomic))} RTM</b>
          </p>
          {draft.payments.map((p) => (
            <p key={p.id}>
              <MemberIdentity
                nickname={
                  p.payerLabel ||
                  contacts.find((c) => c.address === p.payer)?.nickname
                }
                telegram={p.payerTelegram}
                address={p.payer}
              />{" "}
              — {p.amountRtm} RTM
            </p>
          ))}
          <p>
            <UiText text="One signature creates all requests. It does not transfer funds. Each payer approves their own payment." />
          </p>
          <button disabled={busy} onClick={create}>
            <UiText
              text={
                busy
                  ? "Working…"
                  : proof
                    ? "Retry saving same bill"
                    : "Sign and create bill"
              }
            />
          </button>
          {!proof && (
            <button disabled={busy} onClick={() => setDraft(null)}>
              <UiText text="Back to edit" />
            </button>
          )}
          {proof && (
            <p>
              <UiText text="If saving was interrupted, retry the same bill. Do not create another bill before checking My History." />
            </p>
          )}
        </section>
      )}
      {saved.length > 0 && (
        <section className="split-card">
          <h2>
            <UiText text="Bill saved" />
          </h2>
          <p>
            <CopyValue value={saved[0].splitBillId} />
          </p>
          {saved.map((p) => (
            <div className="split-result" key={p.id}>
              <MemberIdentity
                nickname={
                  p.payerLabel ||
                  contacts.find((c) => c.address === p.payer)?.nickname
                }
                telegram={p.payerTelegram}
                address={p.payer}
              />
              <p>
                {p.amountRtm} RTM ·{" "}
                <UiText
                  text={
                    p.notification === "sent"
                      ? "Telegram sent"
                      : p.notification === "disabled"
                        ? "Payment link only — Telegram is optional"
                        : p.notification === "unlinked"
                          ? "Telegram not linked (optional)"
                          : "Telegram delivery not confirmed"
                  }
                />
              </p>
              <p>
                <UiText
                  text={
                    p.status === "paid"
                      ? "Paid"
                      : p.status === "processing"
                        ? "Confirming…"
                        : "Awaiting payment"
                  }
                />
              </p>
              <Link href={`/payments?id=${p.id}`}>
                <UiText text="Open payment request" />
              </Link>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      `${window.location.origin}/payments?id=${p.id}`,
                    );
                    setCopiedLink(p.id);
                  } catch {
                    setError("Copy failed; select and copy manually.");
                  }
                }}
              >
                <UiText
                  text={copiedLink === p.id ? "Copied" : "Copy payment link"}
                />
              </button>
            </div>
          ))}
          <p>
            <UiText text="Track paid and unpaid requests in My History using the bill code in the description." />
          </p>
          <Link href="/requests">
            <UiText text="My History" />
          </Link>
          <button
            onClick={() => {
              localStorage.removeItem(journalKey);
              setSaved([]);
              setMembers([
                { payer: "", amount: "" },
                { payer: "", amount: "" },
              ]);
              setTotal("");
              setDescription("");
            }}
          >
            <UiText text="New bill" />
          </button>
        </section>
      )}
      {error && (
        <p role="alert" className="split-error">
          <UiText text={error} />
        </p>
      )}
    </main>
  );
}
