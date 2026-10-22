"use client";
import { publicStatus, decodePlan } from "../../lib/transactions/public-status";
import { saveReceipt, syncHistory } from "../../lib/transactions/history";

import { withDeadline } from "../../lib/dex/request-state";
import { CopyValue } from "../../components/copy-value";
import { UiText, UiInput } from "../../components/preferences";

import {
  useSharedWallet,
  WalletRequired,
} from "../../components/shared-wallet";
import { assessFunding } from "../../lib/dex/funding";
import { tokenPage, marketSummary, reviewSnapshot } from "../../lib/dex/browser";
import "./dex.css";
import { useEffect, useRef, useState } from "react";
import {
  DEX,
  fmt,
  units,
  output,
  minimum,
  UNIT,
  type Plan,
  type Pool,
} from "../../lib/dex/math";
type Provider = {
  request(input: {
    method: string;
    params?: Record<string, unknown>;
  }): Promise<unknown>;
};
const provider = () => window.retium as Provider | undefined;
type Preview = {
  plan: Plan;
  ticket: string;
  market: {
    symbol: string;
    pool: Pool | null;
    lp: string;
    locked: string;
    untilMs: number;
    balanceRtm: string;
    balanceToken: string;
    codeHash: string;
  };
};
type Market = Preview["market"] & {
  token: string;
  wallet: string;
  readAt: number;
};
type PickerToken = { token: string; symbol: string; supported: boolean };
const short = (value: string) =>
  value ? `${value.slice(0, 8)}…${value.slice(-6)}` : "";
const displayAmount = (value: bigint) => {
  const full = fmt(value),
    [whole, fraction] = full.split(".");
  if (!fraction || fraction.length <= 8) return full;
  return value > 0n && value < 10000000000n
    ? "< 0.00000001"
    : `${whole}.${fraction.slice(0, 8).replace(/0+$/, "") || "0"}`;
};
type Job = {
  txId: string;
  state: string;
  notice: string;
  error?: string;
  plan: Plan;
};
type Recovery = { wallet: string; txId: string; ticket: string };
const message = (e: unknown) =>
  e instanceof Error
    ? e.message
    : typeof e === "object" && e && "message" in e
      ? String(e.message)
      : "Request failed.";
const code = (e: unknown) =>
  typeof e === "object" && e && "code" in e ? String(e.code) : "";
async function post(url: string, body: Record<string, unknown>) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    keepalive: body.operation === "dexRegister",
    signal: AbortSignal.timeout(30000),
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || "Request failed.");
  return d;
}
const completionNotice = (plan: Plan) => plan.approval
  ? "Token approval confirmed. No tokens were swapped. Continue to review the swap or liquidity action."
  : "Completed — HardFinal, execution successful. No further transaction is needed.";
const recoveryKey = "retium-pay:dex-pending:v1";
function AmountPresets({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (percent: number) => void;
}) {
  return (
    <div className="amount-presets" aria-label="Choose amount percentage">
      {[20, 50, 75, 100].map((percent) => (
        <button
          type="button"
          key={percent}
          disabled={disabled}
          onClick={() => onPick(percent)}
        >
          {percent === 100 ? <UiText text={"Max"} /> : `${percent}%`}
        </button>
      ))}
    </div>
  );
}
export default function DexPage() {
  const { account } = useSharedWallet();
  const wallet = account?.address || "";
  const [token, setToken] = useState(""),
    [action, setAction] = useState("swap"),
    [direction, setDirection] = useState("RTM_TO_TOKEN"),
    [amount, setAmount] = useState(""),
    [tokenAmount, setTokenAmount] = useState(""),
    [shares, setShares] = useState(""),
    [lockDays, setLockDays] = useState(""),
    [slip, setSlip] = useState("1");
  const [poolList, setPoolList] = useState<PickerToken[]>([]),
    [cursor, setCursor] = useState<string | null>("0:0"),
    [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [job, setJob] = useState<Job | null>(null),
    [pending, setPending] = useState<Recovery | null>(null),
    [unknown, setUnknown] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [clock, setClock] = useState(0);
  const [backgroundTxs, setBackgroundTxs] = useState<Recovery[]>([]);
  const [marketVersion, setMarketVersion] = useState(0);
  const [picker, setPicker] = useState(false),
    [filter, setFilter] = useState(""),
    [selectedSymbol, setSelectedSymbol] = useState(""),
    [marketData, setMarketData] = useState<Market | null>(null),
    [marketLoading, setMarketLoading] = useState(false),
    [marketError, setMarketError] = useState("");
  useEffect(() => {
    if (!token || !wallet) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setMarketLoading(true);
      setMarketError("");
      marketSummary(token, wallet)
        .then((data) => {
          if (!controller.signal.aborted) {
            setMarketData(data);
            setSelectedSymbol(data.symbol);
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted) {
            setMarketData(null);
            setMarketError(message(e));
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setMarketLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [token, wallet, marketVersion]);
  useEffect(() => {
    if (!picker) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPicker(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [picker]);
  const running = useRef(false),
    epoch = useRef(0);
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(
      () => setClock(Date.now()),
      Math.max(0, preview.plan.expiresAt - Date.now()) + 20,
    );
    return () => clearTimeout(timer);
  }, [preview]);
  useEffect(() => {
    let stopped = false;
    queueMicrotask(() => {
      if (stopped) return;
      try {
        const archived = JSON.parse(localStorage.getItem("retium-pay:dex-background:v1") || "[]");
        if (Array.isArray(archived)) setBackgroundTxs(archived.filter((row) =>
          /^rete[0-9a-f]{68}$/.test(row.wallet) && /^tx_[0-9a-f]{32}$/.test(row.txId) && typeof row.ticket === "string"));
        const raw = localStorage.getItem(recoveryKey);
        if (raw) {
          const p = JSON.parse(raw);
          if (
            /^rete[0-9a-f]{68}$/.test(p.wallet) &&
            typeof p.ticket === "string" &&
            /^tx_[0-9a-f]{32}$/.test(p.txId)
          ) {
            setPending(p);
            setNotice(
              "A submitted TX was restored. Connect its wallet and check it before sending anything else.",
            );
          } else if (p.unknown) {
            setUnknown(true);
            setNotice(
              "A previous wallet request has an unknown outcome. Check wallet history before clearing the hold.",
            );
          }
        }
      } catch {
        /* Optional browser recovery. */
      }
    });
    return () => {
      stopped = true;
    };
  }, []);
  const trackedTx = pending?.txId,
    trackedWallet = pending?.wallet;
  const shouldWatch =
    !!trackedTx &&
    !!wallet &&
    wallet === trackedWallet &&
    (!job || job.state === "pending");
  useEffect(() => {
    if (!shouldWatch || !trackedTx || !pending) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const saved = pending;
    async function poll() {
      try {
        const observed = await publicStatus(saved.ticket,saved.txId,saved.wallet);
        const data = {job: observed};
        saveReceipt({...observed});
        void syncHistory(saved.ticket,saved.txId,saved.wallet);
        if (stopped) return;
        failures = 0;
        setJob(data.job);
        if (data.job.state === "confirmed")
          setNotice(
            completionNotice(data.job.plan),
          );
        else if (data.job.state === "failed")
          setNotice(
            "Transaction failed. Check the details before trying again.",
          );
        else if (data.job.state === "review")
          setNotice(
            data.job.error ||
              "Transaction needs review. Do not resend automatically.",
          );
        const watch =
          data.job.state === "pending";
        if (watch) timer = setTimeout(poll, 5000);
      } catch (error) {
        if (stopped) return;
        failures++;
        setNotice(
          `Status check unavailable: ${message(error)} No transaction has been resent.`,
        );
        timer = setTimeout(
          poll,
          Math.min(30000, 5000 * 2 ** Math.min(failures, 3)),
        );
      }
    }
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [shouldWatch, trackedTx, trackedWallet, wallet, pending]);
  const change = () => {
    epoch.current++;
    setPreview(null);
    setConfirmed(false);
  };
  async function loadPools() {
    if (busy || cursor === null) return;
    setBusy(true);
    try {
      const [page, offset] = cursor.split(":");
      const data = await tokenPage(page, Number(offset));
      setPoolList((old) => [
        ...new Map(
          [...old, ...data.tokens].map((item) => [item.token, item]),
        ).values(),
      ]);
      setCursor(data.next ? `${data.next.cursor}:${data.next.offset}` : null);
    } catch (e) {
      setNotice(message(e));
    } finally {
      setBusy(false);
    }
  }
  function openPicker() {
    setPicker(true);
    setFilter("");
    if (poolList.length === 0) void loadPools();
  }
  function selectToken(item: PickerToken) {
    change();
    setToken(item.token);
    setSelectedSymbol(item.symbol);
    setPicker(false);
  }
  async function prepare(afterApproval = false) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    change();
    const revision = epoch.current;
    try {
      const percent = Number(slip),
        bps = Math.round(percent * 100);
      if (!Number.isFinite(percent) || Math.abs(percent * 100 - bps) > 0.00001)
        throw Error("Use a slippage value with at most two decimals.");
      const snapshot = await withDeadline(
        () => reviewSnapshot(token, wallet),
        45000,
        "Review timed out. No transaction was sent. Edit the amount and try again.",
      );
      if (revision !== epoch.current) return;
      const d = await post("/api/dex", {
        operation: "prepare",
        reviewSnapshot: snapshot,
        wallet,
        token,
        action,
        direction,
        amount,
        tokenAmount,
        shares,
        lockDays,
        bps,
      });
      if (revision !== epoch.current) return;
      if (afterApproval && d.plan.approval)
        throw Error("Approval is confirmed but the available allowance is still insufficient. Refresh and check again; do not approve repeatedly.");
      setPreview(d);
      setMarketData({ ...d.market, token, wallet, readAt: d.plan.createdAt });
      setSelectedSymbol(d.market.symbol);
      setNotice(
        d.plan.approval
          ? "Token approval is required first. The next signature approves only the displayed amount."
          : "Review the exact contract, arguments and minimum amounts before signing. Network data was read by your browser; settlement will be verified separately.",
      );
    } catch (e) {
      // Review never submits a chain transaction. Always release its UI lock on failure.
      running.current = false;
      setBusy(false);
      setPreview(null);
      setConfirmed(false);
      const error = /TimeoutError|AbortError/.test(e instanceof Error ? e.name : "")
        ? "Review timed out. No transaction was sent. Edit the amount and try again."
        : message(e);
      setNotice(/403|Unexpected token|invalid JSON/i.test(error)
        ? "Transaction review is unavailable. No transaction has been sent. Please try again later."
        : error);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function save(r: Recovery) {
    const observed=await publicStatus(r.ticket,r.txId,r.wallet);
    setJob(observed);
    saveReceipt({...observed});
    void syncHistory(r.ticket,r.txId,r.wallet);
    return observed;
  }
  async function execute() {
    if (!preview || running.current || !confirmed || pending || unknown) return;
    // eslint-disable-next-line react-hooks/purity -- This guard runs only from the wallet click handler, never during rendering.
    if (Date.now() > preview.plan.expiresAt) {
      change();
      setNotice("Preview expired. Refresh it before signing.");
      return;
    }
    running.current = true;
    setBusy(true);
    const ready = preview;
    setPreview(null);
    setConfirmed(false);
    // Persist a hold before opening the wallet. A lost response must never trigger an automatic second call.
    try {
      localStorage.setItem(
        recoveryKey,
        JSON.stringify({ unknown: true, wallet }),
      );
    } catch {
      running.current = false;
      setBusy(false);
      setNotice(
        "Browser storage is unavailable. Enable it before submitting a DEX transaction.",
      );
      return;
    }
    setUnknown(true);
    try {
      const p = provider();
      if (!p) throw Error("Wallet unavailable.");
      const result = (await p.request({
        method: "retium_call",
        params: { ...ready.plan.call },
      })) as { txId: string };
      if (!/^tx_[0-9a-f]{32}$/.test(result.txId))
        throw Error(
          "No usable TX ID returned. Check wallet history; do not resend.",
        );
      const recovery = { wallet, txId: result.txId, ticket: ready.ticket };
      localStorage.setItem(recoveryKey, JSON.stringify(recovery));
      setPending(recovery);
      saveReceipt({txId:result.txId,wallet,plan:decodePlan(ready.ticket),state:"pending"});
      setUnknown(false);
      try {
        await save(recovery);
        setNotice(
          "TX submitted and saved — awaiting independent verification. Do not send again. Status is checked directly from the public chain API.",
        );
      } catch (e) {
        setNotice(
          `TX submitted, but tracking could not be saved: ${message(e)}. Do not send again. Click Retry saving TX.`,
        );
      }
    } catch (e) {
      if (
        ["4001", "4300", "4100", "4101", "4102", "4200", "-32602"].includes(
          code(e),
        )
      ) {
        setUnknown(false);
        localStorage.removeItem(recoveryKey);
        setNotice(
          `Wallet did not submit this request: ${message(e)}. Refresh the preview before trying again.`,
        );
      } else
        setNotice(
          `Outcome unknown: ${message(e)}. Check wallet history. Do not resubmit automatically.`,
        );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function check() {
    if (!pending || pending.wallet !== wallet) return;
    setBusy(true);
    try {
      const d = {job: await save(pending)};
      setJob(d.job);
      setNotice(
        d.job.state === "confirmed"
          ? completionNotice(d.job.plan)
          : d.job.state === "pending"
            ? "Awaiting chain confirmation. The Background monitor checks this TX."
            : `${d.job.state}. ${d.job.error || ""}`,
      );
    } catch (e) {
      setNotice(message(e));
    } finally {
      setBusy(false);
    }
  }
  function returnToSwap() {
    // Only detach a TX after the backend has acknowledged its durable registration.
    if (!pending || !job || busy) return;
    try {
      const key = "retium-pay:dex-background:v1";
      const existing = JSON.parse(localStorage.getItem(key) || "[]");
      const rows = Array.isArray(existing) ? existing : [];
      localStorage.setItem(key, JSON.stringify([
        ...rows.filter((row) => row.txId !== pending.txId),
        { ...pending, state: job.state },
      ]));
      setBackgroundTxs([...rows.filter((row) => row.txId !== pending.txId), pending]);
      localStorage.removeItem(recoveryKey);
    } catch {
      setNotice("Could not save TX recovery. Keep this screen open and try again.");
      return;
    }
    setPending(null);
    setJob(null);
    change();
    setMarketVersion((value) => value + 1);
    setNotice("Returned to Swap. Your previous TX remains registered for background verification. Status checks continue independently of this form. Do not repeat the previous swap while its outcome is unknown.");
  }
  function finish() {
    if (!job || !["confirmed", "failed"].includes(job.state)) return;
    const continueAfterApproval = job.state === "confirmed" && job.plan.approval;
    localStorage.removeItem(recoveryKey);
    setPending(null);
    setJob(null);
    change();
    setMarketVersion((value) => value + 1);
    if (continueAfterApproval) {
      // Read fresh allowance and build the next preview only. Never open/sign the wallet automatically.
      void prepare(true);
    } else {
      setNotice("Previous TX is final. Refresh the preview for your next action.");
    }
  }
  const blocked = busy || !!pending || unknown;
  const activeMarket =
    marketData?.token === token && marketData?.wallet === wallet
      ? marketData
      : null;
  const symbol = activeMarket?.symbol || selectedSymbol || "Select token";
  const inputRtm = direction === "RTM_TO_TOKEN";
  let estimate = "—",
    minimumReceive = "—";
  if (action === "swap" && activeMarket?.pool) {
    try {
      const pool = activeMarket.pool;
      const result = output(
        units(amount),
        BigInt(inputRtm ? pool.reserve_rtm : pool.reserve_token),
        BigInt(inputRtm ? pool.reserve_token : pool.reserve_rtm),
      );
      const bps = Math.round(Number(slip) * 100);
      if (bps >= 10 && bps <= 500) {
        estimate = displayAmount(result);
        minimumReceive = displayAmount(minimum(result, bps));
      }
    } catch {
      /* Incomplete decimal input has no quote. */
    }
  }
  const funding = activeMarket
    ? assessFunding({
        action,
        amount,
        tokenAmount,
        bps: Math.round(Number(slip) * 100),
        balanceRtm: activeMarket.balanceRtm,
        balanceToken: activeMarket.balanceToken,
        pool: activeMarket.pool,
      })
    : null;
  const [returnToLiquidity, setReturnToLiquidity] = useState<{
    action: string;
    amount: string;
    tokenAmount: string;
  } | null>(null);
  function swapForFunds(direction: string) {
    if (blocked) return;
    change();
    setReturnToLiquidity({ action, amount, tokenAmount });
    setAction("swap");
    setDirection(direction);
    setAmount("");
    setNotice(
      "Enter a swap amount, review it, then return to liquidity after confirmation.",
    );
  }
  const paySymbol = inputRtm ? "RTM" : symbol,
    receiveSymbol = inputRtm ? symbol : "RTM";
  const payBalance = activeMarket
    ? displayAmount(
        BigInt(inputRtm ? activeMarket.balanceRtm : activeMarket.balanceToken),
      )
    : "—";
  function chooseAmount(kind: "input" | "token" | "lp", percent: number) {
    if (!activeMarket || blocked) return;
    let available = 0n;
    if (kind === "lp")
      available =
        action === "remove"
          ? BigInt(activeMarket.lp) - BigInt(activeMarket.locked)
          : BigInt(activeMarket.lp);
    else if (kind === "token" || (action === "swap" && !inputRtm))
      available = BigInt(activeMarket.balanceToken);
    else {
      const balance = BigInt(activeMarket.balanceRtm);
      available = balance > UNIT ? balance - UNIT : 0n;
      if (action === "add" && activeMarket.pool) {
        const r = BigInt(activeMarket.pool.reserve_rtm),
          t = BigInt(activeMarket.pool.reserve_token),
          tokens = BigInt(activeMarket.balanceToken),
          bps = Math.round(Number(slip) * 100);
        if (
          r <= 0n ||
          t <= 0n ||
          !Number.isInteger(bps) ||
          bps < 10 ||
          bps > 500
        )
          return;
        let low = 0n,
          high = available;
        while (low < high) {
          const mid = (low + high + 1n) / 2n,
            needed = (mid * t + r - 1n) / r,
            cap = (needed * BigInt(10000 + bps) + 9999n) / 10000n;
          if (cap <= tokens) low = mid;
          else high = mid - 1n;
        }
        available = low;
      }
    }
    let selected = (available * BigInt(percent)) / 100n;
    if (
      kind === "lp" &&
      action === "lock" &&
      selected < BigInt(activeMarket.locked)
    )
      selected = BigInt(activeMarket.locked);
    change();
    const value = fmt(selected);
    if (kind === "lp") setShares(value);
    else if (kind === "token") setTokenAmount(value);
    else setAmount(value);
  }
  const primaryLabel = busy
    ? "Please wait…"
    : pending
      ? "Transaction in progress"
      : unknown
        ? "Check previous transaction"
        : !wallet
          ? "Select wallet on Dashboard"
          : !token
            ? "Select token"
            : action === "swap"
                ? "Review swap"
                : action === "add"
                  ? "Review deposit"
                  : action === "create"
                    ? "Review new pool"
                    : action === "remove"
                      ? "Review withdrawal"
                      : "Review lock";
  const primaryAction = () => {
    if (!wallet) return;
    else if (!token) openPicker();
    else void prepare();
  };
  const stage = preview
    ? "review"
    : pending
      ? "transaction"
      : unknown
        ? "recovery"
        : "form";
  useEffect(() => {
    if (stage !== "form") window.scrollTo({ top: 0, behavior: "auto" });
  }, [stage]);
  return (
    <main className={`dex-shell dex-stage-${stage}`}>
      <header>
        <p className="dex-eyebrow">{<UiText text={"RETIUM PAY · TESTNET"} />}</p>
        <h1>{<UiText text={"Swap & liquidity"} />}</h1>
      </header>
      <div className="wallet-strip">
        <div className="dex-code">
          {wallet ? short(wallet) : <WalletRequired />}
        </div>
        {wallet && <span className="dex-tag"><UiText text="Connected" /></span>}
      </div>
      {stage !== "form" && (
        <div className="dex-stage-context">
          <span>
            <UiText text={job?.plan.approval || preview?.plan.approval ? "Token approval step" : "Current request"} /> ·{" "}
            {action === "swap" ? (
              <>
                {amount} {paySymbol} → {receiveSymbol}
              </>
            ) : (
              <>
                <UiText
                  text={
                    action === "add"
                      ? "Add liquidity"
                      : action === "create"
                        ? "Create pool"
                        : action === "remove"
                          ? "Remove liquidity"
                          : "Lock liquidity"
                  }
                />{" "}
                · {symbol}
              </>
            )}
          </span>
        </div>
      )}
      <section className="dex-card trade-card" hidden={stage !== "form"}>
        <div className="dex-tabs">
          {[
            ["swap", "Swap"],
            ["add", "Add liquidity"],
            ["create", "Create pool"],
            ["remove", "Remove liquidity"],
            ["lock", "Lock liquidity"],
          ].map(([v, label]) => (
            <button
              key={v}
              disabled={blocked}
              className={action === v ? "selected" : ""}
              onClick={() => {
                change();
                setAction(v);
              }}
            >
              {<UiText text={label} />}
            </button>
          ))}
        </div>
        {action === "swap" ? (
          <div className="swap-fields">
            <div className="asset-box">
              <div className="asset-caption">
                <span>{<UiText text={"From"} />}</span>
                <span>
                  {<UiText text={"Balance: "} />}
                  {payBalance}
                </span>
              </div>
              <div className="asset-line">
                <button
                  className="token-chip"
                  disabled={blocked}
                  onClick={inputRtm ? undefined : openPicker}
                >
                  <span className={`coin ${inputRtm ? "native" : ""}`}>
                    {inputRtm ? "R" : symbol.slice(0, 1)}
                  </span>
                  {paySymbol}
                  {!inputRtm && " ▾"}
                </button>
                <UiInput
                  aria-label="Amount to pay"
                  disabled={blocked}
                  inputMode="decimal"
                  placeholder="0"
                  value={amount}
                  onChange={(event) => {
                    change();
                    setAmount(event.target.value);
                  }}
                />
              </div>
              <AmountPresets
                disabled={blocked || !activeMarket || marketLoading}
                onPick={(percent) => chooseAmount("input", percent)}
              />
            </div>
            <button
              className="reverse"
              aria-label="Reverse swap direction"
              disabled={blocked}
              onClick={() => {
                change();
                setDirection(inputRtm ? "TOKEN_TO_RTM" : "RTM_TO_TOKEN");
              }}
            >
              ⇅
            </button>
            <div className="asset-box">
              <div className="asset-caption">
                <span>{<UiText text={"To"} />}</span>
                <span>{<UiText text={"Estimated"} />}</span>
              </div>
              <div className="asset-line">
                <button
                  className="token-chip"
                  disabled={blocked}
                  onClick={inputRtm ? openPicker : undefined}
                >
                  <span className={`coin ${!inputRtm ? "native" : ""}`}>
                    {!inputRtm ? "R" : token ? symbol.slice(0, 1) : "?"}
                  </span>
                  {receiveSymbol}
                  {inputRtm && " ▾"}
                </button>
                <output aria-label="Estimated amount received">
                  {marketLoading ? "…" : estimate}
                </output>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="pair-heading">
              <span className="coin native">R</span>
              <b>{<UiText text={"RTM"} />}</b>
              <span>+</span>
              <button
                className="token-chip"
                disabled={blocked}
                onClick={openPicker}
              >
                {token ? symbol : <UiText text={"Select token"} />} ▾
              </button>
            </div>
            {["add", "create"].includes(action) && (
              <>
                {" "}
                <label>
                  {<UiText text={"RTM to deposit"} />}
                  <UiInput
                    disabled={blocked}
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) => {
                      change();
                      setAmount(event.target.value);
                    }}
                  />
                </label>
                <AmountPresets
                  disabled={blocked || !activeMarket || marketLoading}
                  onPick={(percent) => chooseAmount("input", percent)}
                />
              </>
            )}
          </>
        )}
        {marketError && <p className="inline-error">{marketError}</p>}
        {action !== "swap" && activeMarket && (
          <div className="position-info">
            <span>
              {<UiText text={"Available RTM"} />}{" "}
              <b>{displayAmount(BigInt(activeMarket.balanceRtm))}</b>
            </span>
            <span>
              {symbol}
              {<UiText text={" balance"} />}{" "}
              <b>{displayAmount(BigInt(activeMarket.balanceToken))}</b>
            </span>
            <span>
              {<UiText text={"LP shares "} />}
              <b>{displayAmount(BigInt(activeMarket.lp))}</b>
            </span>
            <span>
              {<UiText text={"Locked shares "} />}
              <b>{displayAmount(BigInt(activeMarket.locked))}</b>
            </span>
          </div>
        )}
        {funding?.insufficient && (
          <section className="funding-alert" role="status">
            <h3>
              <UiText text={"Not enough assets for liquidity"} />
            </h3>
            {(funding.tokenShort > 0n || funding.zeroToken) && (
              <>
                <p>
                  <UiText text={"Token balance:"} />{" "}
                  <strong>
                    {fmt(funding.balanceToken)} {symbol}
                  </strong>
                </p>
                {funding.requiredToken !== null && (
                  <p>
                    <UiText text={"Token required (maximum):"} />{" "}
                    <strong>
                      {fmt(funding.requiredToken)} {symbol}
                    </strong>
                    <br />
                    <UiText text={"Shortfall:"} />{" "}
                    <strong>
                      {fmt(funding.tokenShort)} {symbol}
                    </strong>
                  </p>
                )}
                <p>
                  <UiText
                    text={
                      funding.hasPool
                        ? "Swap RTM for this token before adding liquidity, or reduce the deposit."
                        : "No pool exists for this token yet. Receive tokens into your wallet before creating its first pool."
                    }
                  />
                </p>
                {funding.canBuyToken && (
                  <button
                    type="button"
                    disabled={blocked}
                    onClick={() => swapForFunds("RTM_TO_TOKEN")}
                  >
                    <UiText text={"Go to Swap · buy token"} />
                  </button>
                )}
              </>
            )}
            {funding.rtmShort > 0n && (
              <>
                <p>
                  <UiText text={"RTM needed including fee buffer:"} />{" "}
                  <strong>{fmt(funding.requiredRtm)} RTM</strong>
                  <br />
                  <UiText text={"Available:"} /> {fmt(funding.balanceRtm)} RTM
                  <br />
                  <UiText text={"Shortfall:"} />{" "}
                  <strong>{fmt(funding.rtmShort)} RTM</strong>
                </p>
                <p>
                  <UiText
                    text={
                      "Top up RTM or reduce the deposit. The 1 RTM buffer is not a fee quote."
                    }
                  />
                </p>
                {funding.canSellToken && (
                  <button
                    type="button"
                    disabled={blocked}
                    onClick={() => swapForFunds("TOKEN_TO_RTM")}
                  >
                    <UiText text={"Go to Swap · get RTM"} />
                  </button>
                )}
              </>
            )}
            <p>
              <UiText
                text={
                  "Amounts use the displayed balance snapshot; Review checks fresh balances again."
                }
              />
            </p>
          </section>
        )}
        {action === "swap" && returnToLiquidity && (
          <div className="liquidity-return">
            <button
              type="button"
              disabled={blocked}
              onClick={() => {
                if (blocked) return;
                change();
                setAction(returnToLiquidity.action);
                setAmount(returnToLiquidity.amount);
                setTokenAmount(returnToLiquidity.tokenAmount);
                setReturnToLiquidity(null);
                setMarketVersion((v) => v + 1);
                setNotice("");
              }}
            >
              <UiText text={"Return to liquidity"} />
            </button>
            <p>
              <UiText
                text={
                  "After the swap confirms, return and refresh balances before reviewing the deposit."
                }
              />
            </p>
          </div>
        )}
        {action === "swap" && token && (
          <p className="quote-caption">
            {<UiText text={"Minimum received: "} />}
            {minimumReceive} {receiveSymbol}
          </p>
        )}
        {wallet && token && (
          <button
            className="refresh-quote"
            disabled={blocked || marketLoading}
            onClick={() => {
              change();
              setMarketVersion((version) => version + 1);
            }}
          >
            {marketLoading ? (
              <UiText text={"Updating quote…"} />
            ) : (
              <UiText text={"↻ Refresh balances & quote"} />
            )}
          </button>
        )}
        {action === "create" && (
          <>
            {" "}
            <label>
              {<UiText text={"Token to deposit"} />}
              <UiInput
                disabled={blocked}
                inputMode="decimal"
                value={tokenAmount}
                onChange={(e) => {
                  change();
                  setTokenAmount(e.target.value);
                }}
              />
            </label>
            <AmountPresets
              disabled={blocked || !activeMarket || marketLoading}
              onPick={(percent) => chooseAmount("token", percent)}
            />
          </>
        )}
        {["remove", "lock"].includes(action) && (
          <>
            {" "}
            <label>
              {action === "lock" ? (
                <UiText text={"Total LP shares to lock"} />
              ) : (
                <UiText text={"LP shares to withdraw"} />
              )}
              <UiInput
                disabled={blocked}
                inputMode="decimal"
                value={shares}
                onChange={(e) => {
                  change();
                  setShares(e.target.value);
                }}
              />
            </label>
            <AmountPresets
              disabled={blocked || !activeMarket || marketLoading}
              onPick={(percent) => chooseAmount("lp", percent)}
            />
          </>
        )}
        {action === "lock" && (
          <label>
            {<UiText text={"Lock duration · days"} />}
            <UiInput
              disabled={blocked}
              value={lockDays}
              onChange={(e) => {
                change();
                setLockDays(e.target.value);
              }}
            />
            <small>
              {
                <UiText
                  text={
                    "1–3650 days. Existing locks cannot be shortened. Permanent locks are not offered here."
                  }
                />
              }
            </small>
          </label>
        )}
        <details className="swap-settings">
          <summary>
            {<UiText text={"Slippage "} />}
            <b>{slip}%</b>
          </summary>
          <label>
            {<UiText text={"Slippage tolerance (%)"} />}
            <UiInput
              disabled={blocked}
              value={slip}
              inputMode="decimal"
              onChange={(event) => {
                change();
                setSlip(event.target.value);
              }}
            />
            <small>
              {
                <UiText
                  text={
                    "Between 0.10% and 5.00%. Lower tolerance reduces price movement you accept."
                  }
                />
              }
            </small>
          </label>
        </details>
        {action === "swap" && (
          <p className="dex-muted">
            {<UiText text={"Pool fee 0.3%. The network fee is separate."} />}
          </p>
        )}
        {activeMarket && !activeMarket.pool && action !== "create" && (
          <div className="dex-muted" role="status">
            <p><UiText text="This token has no liquidity pool. Create a pool before swapping or adding liquidity." /></p>
            <button type="button" disabled={blocked} onClick={() => { change(); setAction("create"); }}>
              <UiText text="Create pool" />
            </button>
          </div>
        )}
        <button
          className="primary-action"
          disabled={blocked || !wallet || !!funding?.insufficient}
          onClick={primaryAction}
        >
          {<UiText text={primaryLabel} />}
        </button>
        {token && (
          <details className="contract-details">
            <summary>{<UiText text={"Token details"} />}</summary>
            <p>
              {symbol}
              {<UiText text={" · 18 decimals"} />}
            </p>
            <p className="dex-code">{token}</p>
            <p className="dex-muted">
              {
                <UiText
                  text={
                    "Names can be duplicated. Check the contract when selecting a token."
                  }
                />
              }
            </p>
          </details>
        )}
      </section>
      {preview && (
        <section className="dex-card review-card">
          <p className="dex-eyebrow">
            {<UiText text={"REVIEW BEFORE SIGNING"} />}
          </p>
          <h2>
            {preview.plan.approval ? (
              `Approve ${preview.plan.symbol}`
            ) : action === "swap" ? (
              <UiText text={"Review swap"} />
            ) : (
              <UiText text={"Review liquidity action"} />
            )}
          </h2>
          {preview.plan.summary.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <p className="dex-muted">
            {
              <UiText
                text={
                  "1 RTM fee buffer is required beyond attached funds. It is not a fee quote."
                }
              />
            }
          </p>
          <details className="contract-details">
            <summary>
              {<UiText text={"Contract & transaction details"} />}
            </summary>
            <p>
              {<UiText text={"Wallet RTM: "} />}
              {fmt(BigInt(preview.market.balanceRtm))}
              {<UiText text={" · Token:"} />}{" "}
              {fmt(BigInt(preview.market.balanceToken))}
            </p>
            <p>
              {<UiText text={"LP shares: "} />}
              {fmt(BigInt(preview.market.lp))}
              {<UiText text={" · Locked:"} />}{" "}
              {fmt(BigInt(preview.market.locked))}
            </p>
            <p className="dex-code">
              {<UiText text={"Trading contract: "} />}
              {DEX}
              <br />
              {<UiText text={"Token: "} />}
              {token}
              <br />
              {<UiText text={"Token code hash: "} />}
              {preview.market.codeHash}
              <br />
              {<UiText text={"Calling: "} />}
              {preview.plan.call.contractId}
              <br />
              {<UiText text={"Method: "} />}
              {preview.plan.call.method}
              <br />
              {<UiText text={"Arguments: "} />}
              {preview.plan.call.args.join(",")}
              <br />
              {<UiText text={"Attached RTM: "} />}
              {fmt(BigInt(preview.plan.call.amountAtomic))}
            </p>
          </details>
          <label className="dex-confirm">
            <UiInput
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {<UiText text={"I checked the token contract, amounts and"} />}{" "}
            {action === "lock" ? (
              <UiText text={"lock date"} />
            ) : (
              <UiText text={"minimums"} />
            )}
            .
          </label>
          <button
            className="back-to-edit"
            disabled={busy}
            onClick={() => {
              change();
              setNotice("");
            }}
          >
            <UiText text={"Back to edit"} />
          </button>
          <button
            disabled={busy || !confirmed || clock > preview.plan.expiresAt}
            onClick={() => void execute()}
          >
            {clock > preview.plan.expiresAt ? (
              <UiText text={"Preview expired — refresh"} />
            ) : preview.plan.approval ? (
              <UiText text={"Approve exact token amount"} />
            ) : action === "swap" ? (
              <UiText text={"Confirm swap in wallet"} />
            ) : (
              <UiText text={"Confirm in wallet"} />
            )}
          </button>
          <p className="dex-muted">
            {
              <UiText
                text={
                  "Preview expires after 60 seconds. A wallet request can take longer; contract deadlines are 20 minutes. Every call needs separate approval."
                }
              />
            }
          </p>
        </section>
      )}
      {!pending && backgroundTxs.some((row) => row.wallet === wallet) && (
        <section className="dex-card">
          <h2><UiText text="Saved transactions" /></h2>
          {backgroundTxs.filter((row) => row.wallet === wallet).map((row) => (
            <div key={row.txId}>
              <CopyValue value={row.txId} />
              <button disabled={busy} onClick={() => {
                localStorage.setItem(recoveryKey, JSON.stringify(row));
                setJob(null);
                setPending(row);
                setPreview(null);
              }}><UiText text="Open TX status" /></button>
            </div>
          ))}
        </section>
      )}
      {pending && (
        <section className="dex-card transaction-card">
          <h2>
            {job?.state === "confirmed" ? (
              <UiText text={job.plan.approval ? "✓ Token approval confirmed" : "✓ Completed"} />
            ) : job?.state === "failed" ? (
              <UiText text={"Transaction failed"} />
            ) : (
              <UiText text={"Transaction status"} />
            )}
          </h2>
          <p className="dex-code"><CopyValue value={pending.txId} /></p>
          <button
            disabled={busy || wallet !== pending.wallet}
            onClick={check}
          >
            {<UiText text={"Check status now"} />}
          </button>
          {job && (
            <>
              <p>
                {<UiText text={"Status:"} />}{" "}
                <b>
                  {job.state === "confirmed" ? (
                    <UiText text={job.plan.approval ? "Approval confirmed · HardFinal" : "Completed · HardFinal"} />
                  ) : job.state === "pending" ? (
                    <UiText text={"Confirming…"} />
                  ) : (
                    job.state
                  )}
                </b>{" "}

              </p>
              <p>{job.error}</p>
              {["confirmed", "failed"].includes(job.state) && (
                <button onClick={finish}>
                  {<UiText text={job.state === "confirmed" && job.plan.approval ? "Continue — review next transaction" : "Done — return to form"} />}
                </button>
              )}
            </>
          )}
          {job && !["confirmed", "failed"].includes(job.state) && (
            <button disabled={busy} onClick={returnToSwap}>
              <UiText text="Back to Swap — keep tracking TX" />
            </button>
          )}
          <p className="dex-muted">
            {
              <UiText
                text={
                  "HardFinal alone is not enough: execution must also be ok. A confirmed call does not make an estimated output an exact receipt."
                }
              />
            }
          </p>
        </section>
      )}
      {unknown && (
        <section className="dex-card recovery-card">
          <h2>{<UiText text={"Check wallet history before continuing"} />}</h2>
          <p>
            {
              <UiText
                text={
                  "The wallet outcome is unknown. Do not repeat the call. Keep this hold until you have checked the submitted transactions in your wallet."
                }
              />
            }
          </p>
          <button
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  "Have you checked wallet history and confirmed no pending or submitted transaction remains?",
                )
              ) {
                localStorage.removeItem(recoveryKey);
                setUnknown(false);
                change();
              }
            }}
          >
            {<UiText text={"I checked wallet history — clear hold"} />}
          </button>
        </section>
      )}
      {picker && (
        <div className="picker-overlay" onClick={() => setPicker(false)}>
          <section
            className="token-picker"
            role="dialog"
            aria-modal="true"
            aria-labelledby="picker-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="picker-heading">
              <h2 id="picker-title">{<UiText text={"Select a token"} />}</h2>
              <button
                className="close-picker"
                aria-label="Close token selector"
                onClick={() => setPicker(false)}
              >
                ×
              </button>
            </div>
            <UiInput
              aria-label="Search tokens"
              placeholder="Search name or paste contract address"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <p className="dex-muted">
              {
                <UiText
                  text={
                    "Tokens available in Retium Pay. Match the contract as well as the name."
                  }
                />
              }
            </p>
            <div className="token-list">
              {poolList
                .filter(
                  (item) =>
                    item.symbol.toLowerCase().includes(filter.toLowerCase()) ||
                    item.token.includes(filter.toLowerCase()),
                )
                .map((item) => (
                  <button
                    className="token-row"
                    key={item.token}
                    disabled={!item.supported || blocked}
                    onClick={() => selectToken(item)}
                  >
                    <span className="coin">{item.symbol.slice(0, 1)}</span>
                    <span>
                      <b>{item.symbol}</b>
                      <small>{short(item.token)}</small>
                    </span>
                    <span className="picker-chevron">›</span>
                  </button>
                ))}
            </div>
            {/^[0-9a-f]{64}$/.test(filter.trim().toLowerCase()) && (
              <button
                disabled={blocked}
                onClick={() =>
                  selectToken({
                    token: filter.trim().toLowerCase(),
                    symbol: "Token",
                    supported: true,
                  })
                }
              >
                {<UiText text={"Use this contract"} />}
              </button>
            )}
            <button
              className="load-tokens"
              disabled={busy || cursor === null}
              onClick={loadPools}
            >
              {busy ? (
                <UiText text={"Loading tokens…"} />
              ) : cursor === null ? (
                <UiText text={"All available pool pages loaded"} />
              ) : (
                <UiText text={"Load more tokens"} />
              )}
            </button>
            <p className="dex-muted">
              {
                <UiText
                  text={
                    "Only supported tokens declaring 18 decimals can be traded in this release."
                  }
                />
              }
            </p>
          </section>
        </div>
      )}
      <p role="status" className="dex-notice">
        {<UiText text={notice} />}
      </p>
      <p className="dex-muted">
        {
          <UiText
            text={
              "Saved TXs are verified in the background. You can close this page. Testnet only."
            }
          />
        }
      </p>
    </main>
  );
}

