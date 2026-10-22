"use client";
import { publicStatus, decodePlan } from "../../lib/transactions/public-status";
import { saveReceipt, syncHistory } from "../../lib/transactions/history";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSharedWallet } from "../../components/shared-wallet";
import { UiText } from "../../components/preferences";
import { CopyValue } from "../../components/copy-value";
import type { LendingConfig } from "../../lib/lending/config";
import { snapshot, readPublic, type Snapshot } from "../../lib/lending/browser";
import {
  actions,
  type LendingAction,
} from "../../lib/lending/plan";
import { repayLimits, collateralAvailable, borrowAvailable } from "../../lib/lending/amounts";
import { units, fmt, type Plan } from "../../lib/dex/math";
import "./lending.css";
import { SafehouseRefresh } from "./safehouse-refresh";
import { displayAmount, healthDisplay } from "./display";
type Preview = { plan: Plan; ticket: string; displayAmount?: string };
type Pending = {
  wallet: string;
  market: string;
  ticket: string;
  txId: string;
  unknown?: boolean;
};
// Compare allowance with the repayment plus a small signing-time margin.
// A new approval grants a larger 0.1% buffer. Never require that entire
// buffer again after every accrual, or approvals repeat indefinitely.
const shortAmount = displayAmount;
const recoveryPrefix = "retium-pay:lending:pending:v1:";
const error = (e: unknown) => {
  if (e && typeof e === "object") {
    const value = e as { code?: unknown; message?: unknown };
    return `${value.code === undefined ? "" : `[${String(value.code)}] `}${typeof value.message === "string" ? value.message.slice(0, 700) : "Request failed. Please retry."}`;
  }
  return typeof e === "string"
    ? e.slice(0, 700)
    : "Request failed. Please retry.";
};
async function post(url: string, body: unknown) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const d = await r.json();
  if (!r.ok || d.error) throw Error(d.error || `HTTP ${r.status}`);
  return d;
}
export default function Lending() {
  const { account } = useSharedWallet(),
    wallet = account?.address || "";
  const recovery = recoveryPrefix + wallet;
  const [config, setConfig] = useState<LendingConfig | null>(null),
    [data, setData] = useState<Snapshot | null>(null),
    [action, setAction] = useState<LendingAction>("supply"),
    [amount, setAmount] = useState(""),
    [useMax, setUseMax] = useState(false),
    [editingAmount, setEditingAmount] = useState(false),
    [preview, setPreview] = useState<Preview | null>(null),
    [pending, setPending] = useState<Pending | null>(null),
    [notice, setNotice] = useState(""),
    [adminBlocked, setAdminBlocked] = useState(false),
    [lastTx, setLastTx] = useState(""),
    [group, setGroup] = useState<"save" | "borrow">("save"),
    [busy, setBusy] = useState(false),
    [recoveryTx, setRecoveryTx] = useState("");
  const lock = useRef(false);
  const activeWallet = useRef(wallet);
  useEffect(() => { activeWallet.current = wallet; }, [wallet]);
  const symbol = config?.symbol || "RTD";
  const actionLabel = {
    supply: `Supply ${symbol}`,
    withdraw: `Withdraw ${symbol}`,
    repay: `Repay ${symbol}`,
    borrow: `Borrow ${symbol}`,
    deposit_collateral: "Deposit collateral RTM",
    withdraw_collateral: "Withdraw collateral RTM",
  }[action];
  // Cached allowance only predicts the label. review() always reads fresh chain state.
  let needsApproval = false;
  if (data && ["supply", "repay"].includes(action)) {
    try {
      let needed = units(amount);
      if (action === "repay") {
        if (useMax) needed = BigInt(data.position.debt);
        needed = repayLimits(needed).required;
      }
      needsApproval = needed > BigInt(data.allowance);
    } catch { /* Invalid inputs are explained by the preparation step. */ }
  }
  const nextLabel = needsApproval ? `Approve ${symbol}` : actionLabel;

  useEffect(() => {
    let live = true;
    fetch("/api/lending", { cache: "no-store" })
      .then((r) => r.json())
      .then((c) => {
        if (live) setConfig(c);
      })
      .catch(() => {
        if (live) setNotice("Could not load lending configuration.");
      });
    Promise.resolve().then(() => {
      if (!live) return;
      try {
        setData(null);
        setLastTx("");
        setPreview(null);
        const p = JSON.parse(localStorage.getItem(recovery) || "null");
        setPending(
          p &&
            p.wallet === wallet &&
            typeof p.ticket === "string" &&
            typeof p.market === "string"
            ? p
            : null,
        );
      } catch {
        setNotice(
          "Could not restore saved transaction. Check wallet history before sending.",
        );
      }
    });
    return () => {
      live = false;
    };
  }, [wallet, recovery]);
  useEffect(() => {
    if (!config?.enabled || !wallet) return;
    let live = true;
    snapshot(config, wallet).then((fresh) => { if (live) setData(fresh); })
      .catch((e) => { if (live) setNotice(error(e)); });
    return () => { live = false; };
  }, [config, wallet]);
  async function refresh() {
    if (!config || !wallet) return;
    setPreview(null);
    setBusy(true);
    try {
      setData(await snapshot(config, wallet));
      setNotice("Position refreshed.");
    } catch (e) {
      setData(null);
      setNotice(error(e));
    } finally {
      setBusy(false);
    }
  }
  function change(next: LendingAction) {
    setAction(next);
    setNotice("");
    setAmount("");
    setUseMax(false);
    setPreview(null);
  }
  async function review() {
    if (!config || !wallet || lock.current || adminBlocked) return;
    lock.current = true;
    setBusy(true);
    setPreview(null);
    setLastTx("");
    try {
      if (!window.retium) throw Error("Wallet SDK is not ready.");
      // Reuse the wallet selected on Dashboard. Review performs reads, never a signature.
      if (Number(account?.chainId) !== 3)
        throw Error("Select the Retium test network on Dashboard.");
      const fresh = await snapshot(config, wallet);
      if (activeWallet.current !== wallet) throw Error("Wallet changed. Start again with the selected wallet.");
      setData(fresh);
      const m = fresh.market,
        p = fresh.position;
      const shares = ["withdraw", "repay"].includes(action);
      const requested = units(amount);
      let n = requested;
      if (shares) {
        const owned = BigInt(action === "repay" ? p.debt_shares : p.supply_shares);
        const total = action === "repay" ? BigInt(p.debt) : BigInt(p.supplied);
        if (owned <= 0n || total <= 0n) throw Error("No position available for this action.");
        if (!useMax && requested > total) throw Error("Amount exceeds your position. Use Max to select the full position.");
        // The contract accepts shares. Convert token amounts with integer arithmetic only.
        // Max selects all shares from the fresh read, including accrued debt.
        n = useMax ? owned : action === "repay"
          ? requested * 10n ** 18n / BigInt(m.index)
          : requested * BigInt(m.supply_shares) / BigInt(m.assets);
        if (n > owned) n = owned;
      }
      if (n <= 0n) throw Error("Enter a positive amount.");
      if (
        ["supply", "borrow"].includes(action) &&
        (m.paused !== "0" || m.asset_verified !== "1")
      )
        throw Error("Market paused or asset not verified.");
      if (action === "borrow" && n < 10n ** 15n) throw Error("Minimum test loan is 0.001 RTD.");
      if (action === "borrow" && m.price_fresh !== "true")
        throw Error("Test price expired. Borrowing is unavailable.");
      let need = action === "supply" ? n : 0n;
      let approvalLimit = need;
      if (action === "supply" && n > BigInt(fresh.balance))
        throw Error("Insufficient debt asset balance.");
      if (action === "withdraw") {
        if (n > BigInt(p.supply_shares))
          throw Error("Insufficient supply shares.");
        const output = (n * BigInt(m.assets)) / BigInt(m.supply_shares);
        if (output > BigInt(m.cash))
          throw Error("Insufficient available liquidity.");
      }
      if (
        action === "borrow" &&
        n > borrowAvailable(p,m)
      )
        throw Error("Amount exceeds available liquidity or the safe borrow limit. Use Max to include the signing-time reserve.");
      if (action === "withdraw_collateral") {
        if (useMax) { n = collateralAvailable(p, m); setAmount(fmt(n)); }
        if (n <= 0n) throw Error("No collateral can be withdrawn now. Repay debt or wait for a fresh test price.");
        if (n > BigInt(p.collateral)) throw Error("Insufficient collateral.");
        if (
          BigInt(p.debt) > 0n &&
          (m.price_fresh !== "true" ||
            BigInt(p.debt) >
              ((BigInt(p.collateral) - n) * BigInt(m.price)) / 10n ** 18n / 2n)
        )
          throw Error(
            "Repay debt first or withdraw less collateral. A fresh test price is required.",
          );
      }
      if (action === "repay") {
        if (n > BigInt(p.debt_shares)) throw Error("Insufficient debt shares.");
        need = (n * BigInt(m.index) + 10n ** 18n - 1n) / 10n ** 18n;
        const limits = repayLimits(need);
        need = limits.required;
        approvalLimit = limits.approval;
        if (need > BigInt(fresh.balance))
          throw Error(
            "Insufficient debt asset balance including the interest allowance buffer.",
          );
      }
      const approval = need > BigInt(fresh.allowance);
      const d = await post("/api/lending", {
        wallet,
        action,
        amount: shares ? "1" : fmt(n),
        shares: shares ? String(n) : "",
        nonce: fresh.nonce,
        approval,
        maxRepayAtomic: String(approvalLimit),
      });
      if (shares && !approval) {
        const estimate = action === "withdraw"
          ? n * BigInt(m.assets) / BigInt(m.supply_shares)
          : (n * BigInt(m.index) + 10n ** 18n - 1n) / 10n ** 18n;
        d.plan.summary.push(`${action === "withdraw" ? "You will receive" : "Estimated repayment"}: ${fmt(estimate)} ${config.symbol}`);
        if (action === "repay") d.plan.summary.push("Repayment may increase slightly with accrued interest before execution. Approval includes a 0.1% allowance buffer.");
      }
      const actualAmount = approval ? BigInt(d.plan.call.args[1])
        : action === "withdraw" ? n * BigInt(m.assets) / BigInt(m.supply_shares)
        : action === "repay" ? (n * BigInt(m.index) + 10n ** 18n - 1n) / 10n ** 18n : n;
      if (activeWallet.current !== wallet) throw Error("Wallet changed. Prepare again.");
      setPreview({ ...d, displayAmount: fmt(actualAmount) });
      setNotice(
        approval
          ? "Approval is a separate transaction. After confirmation, review this action again."
          : "Review the contract call. In the signing popup, confirm the same wallet address and amounts before signing.",
      );
    } catch (e) {
      setNotice(error(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function selectPercent(percent: number) {
    if (!config || !wallet || busy || pending || lock.current) return;
    lock.current = true;
    setBusy(true);
    setPreview(null);
    try {
      const fresh = await snapshot(config, wallet);
      if (activeWallet.current !== wallet) throw Error("Wallet changed. Start again with the selected wallet.");
      setData(fresh);
      let total = 0n;
      if (action === "supply") total = BigInt(fresh.balance);
      if (action === "withdraw") total = BigInt(fresh.position.supplied);
      if (action === "repay") total = BigInt(fresh.position.debt);
      if (action === "borrow") {
        if (fresh.market.price_fresh !== "true") throw Error("Price feed expired. Borrowing is paused until a fresh update. Repayment remains available.");
        total = borrowAvailable(fresh.position,fresh.market);
      }
      if (action === "withdraw_collateral") total = collateralAvailable(fresh.position, fresh.market);
      if (action === "deposit_collateral") {
        if (fresh.rtmBalance == null) throw Error("RTM balance unavailable. Refresh and retry.");
        const balance = BigInt(fresh.rtmBalance);
        // Keep 1 RTM for this transaction and subsequent gas; never sweep the wallet.
        total = balance > 10n ** 18n ? balance - 10n ** 18n : 0n;
      }
      setAmount(fmt(total * BigInt(percent) / 100n));
      setUseMax(percent === 100 && ["withdraw", "repay", "withdraw_collateral"].includes(action));
      setNotice(action === "deposit_collateral"
        ? "Percentage uses your RTM balance minus a 1 RTM gas reserve."
        : action === "borrow"
          ? "Percentage uses available liquidity and a small interest and rounding reserve."
          : "Percentage calculated from your refreshed balance or position.");
    } catch (e) { setNotice(error(e)); }
    finally { lock.current = false; setBusy(false); }
  }
  async function execute() {
    if (!preview || pending || lock.current || !config || adminBlocked) return;
    const ready = preview;
    if (Date.now() > ready.plan.expiresAt) {
      setPreview(null);
      setNotice("Preview expired. Review again.");
      return;
    }
    lock.current = true;
    setBusy(true);
    setPreview(null);
    let hold: Pending | null = null;
    try {
      if (!window.retium) throw Error("Wallet unavailable.");
      if (ready.plan.wallet !== wallet || Number(account?.chainId) !== 3)
        throw Error(
          "Preview belongs to a different wallet or network. Review again.",
        );
      // One wallet call per click. Reuse the Dashboard account; confirm the same account in the signing popup.
      hold = {
        wallet,
        market: config.market,
        ticket: ready.ticket,
        txId: "",
        unknown: true,
      };
      localStorage.setItem(recovery, JSON.stringify(hold));
      setPending(hold);
      // No await before this request. SDK opens the transaction popup in this click gesture.
      const result = (await window.retium.request({
        method: "retium_call",
        params: { ...ready.plan.call },
      })) as { txId?: string };
      if (!result || !/^tx_[0-9a-f]{32}$/.test(result.txId || ""))
        throw Error(
          "Wallet returned no usable TX ID. Check wallet history before another action.",
        );
      hold = { ...hold, txId: result.txId!, unknown: false };
      localStorage.setItem(recovery, JSON.stringify(hold));
      setPending(hold);
      saveReceipt({txId:hold.txId,wallet,plan:decodePlan(hold.ticket),state:"pending"});
      void syncHistory(hold.ticket,hold.txId,wallet);
      setNotice("Transaction submitted. Checking execution automatically…");
    } catch (e) {
      const code = String((e as { code?: unknown })?.code || "");
      if (
        hold &&
        ["4001", "4300", "4100", "4101", "4102", "4200", "-32602"].includes(
          code,
        )
      ) {
        localStorage.removeItem(recovery);
        setPending(null);
      }
      setNotice(error(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const check = useCallback(async () => {
    if (!pending || pending.wallet !== wallet || !config || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      let p = pending;
      if (p.unknown) {
        if (!/^tx_[0-9a-f]{32}$/.test(recoveryTx))
          throw Error(
            "Paste the TX ID from wallet history. Never repeat an uncertain transaction.",
          );
        p = { ...p, txId: recoveryTx, unknown: false };
        localStorage.setItem(recovery, JSON.stringify(p));
        setPending(p);
      }
      const observed=await publicStatus(p.ticket,p.txId,p.wallet);
      if(activeWallet.current !== wallet) return;
      const expected=observed.plan;
      saveReceipt({...observed});
      void syncHistory(p.ticket,p.txId,p.wallet);
      if(observed.state === "confirmed") {
        localStorage.removeItem(recovery);
        setPending(null);
        setLastTx(p.txId);
        setNotice(expected.approval
          ? "Approval confirmed. Click Repay / Supply to prepare the actual transaction, then Confirm & sign. Approval alone does not repay or supply funds."
          : "Transaction successful · HardFinal · execution OK.");
        try { setData(await snapshot(config, wallet)); }
        catch { setNotice("Transaction successful · HardFinal. Position refresh unavailable; use Refresh position. Do not resend."); }
      } else if (observed.state === "failed") {
        localStorage.removeItem(recovery);
        setPending(null);
        setNotice("Transaction failed. You can review a new action.");
      } else
        setNotice(observed.state === "review" ? observed.error : "Still awaiting final execution. You can leave this page and check later.");
    } catch (e) {
      setNotice(error(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }, [pending, config, recoveryTx, recovery, wallet]);
  useEffect(() => {
    if (!pending?.txId || pending.unknown || pending.wallet !== wallet) return;
    const timer = setInterval(() => { if (!document.hidden) void check(); }, 8000);
    return () => clearInterval(timer);
  }, [pending, wallet, check]);
  const selectedUnit = action.includes("collateral") ? "RTM" : symbol;
  const actionNames: Record<LendingAction, string> = {supply:"Supply RTD",withdraw:"Withdraw RTD",borrow:"Borrow RTD",repay:"Repay RTD",deposit_collateral:"Deposit RTM collateral",withdraw_collateral:"Withdraw RTM collateral"};
  const amountIsPositive = (() => {try{return units(amount)>0n;}catch{return false;}})();
  const allowanceStep = ["supply", "repay"].includes(action);
  const health = data ? healthDisplay(data.position.health_factor,data.position.debt,data.market.price_fresh === "true") : null;
  const shownAvailable = (() => {
    if(!data)return "—";
    if(action === "supply" || action === "repay")return fmt(BigInt(data.balance));
    if(action === "withdraw")return fmt(BigInt(data.position.supplied));
    if(action === "borrow")return fmt(borrowAvailable(data.position,data.market));
    if(action === "withdraw_collateral")return fmt(collateralAvailable(data.position,data.market));
    return data.rtmBalance == null ? null : fmt(BigInt(data.rtmBalance));
  })();
  const estimate = (() => {
    if(!data || !amountIsPositive)return null;
    try {
      const n=units(preview && !preview.plan.approval ? preview.displayAmount || amount : amount);
      const key=action === "supply" || action === "withdraw" ? "supplied" : action.includes("collateral") ? "collateral" : "debt";
      const base=BigInt(data.position[key]);
      const add=["supply","deposit_collateral","borrow"].includes(action);
      return {key,value:fmt(add ? base+n : n>base ? 0n : base-n)};
    } catch {return null;}
  })();
  return (
    <main className="lending-page lending-redesign">
      <div className="eyebrow">RETIUM PAY · TESTNET</div>
      <div className="lending-title-row"><h1><UiText text="Lending & Borrowing" /></h1><span className="lending-badge">Testnet</span></div>
      <p className="muted">
        <UiText text="Supply a debt asset. Use RTM as collateral. Keep control of every signature." />
      </p>
      <div className="warning">
        {data?.market.oracle_mode === "safehouse_reference_feed" ? <UiText text="Testnet · Safehouse reference: 1 RTM = 1 RTD. Refreshed by a dedicated publisher checking the official API. Centralized feed; not a market-price oracle." /> : <UiText text="Experimental testnet market. Prices are entered by the administrator, not a decentralized oracle. Use test assets only." />}
      </div>
      {!config ? (
        <p>
          <UiText text="Loading market configuration…" />
        </p>
      ) : !config.enabled ? (
        <section className="lending-card">
          <h2>
            <UiText text="Market awaiting verification" />
          </h2>
          <p>
            <UiText text="The contract and lending interface are prepared. Live transactions stay disabled until the debt asset and deployed contract are verified." />
          </p>
          <p className="muted">
            <UiText text="No deposit or loan has been created." />
          </p>
        </section>
      ) : !wallet ? (
        <section className="lending-card">
          <Link href="/">
            <UiText text="Select your wallet on the dashboard" />
          </Link>
        </section>
      ) : (
        <div className="lending-grid">
          <section className="lending-card">
            <h2 className="sr-only"><UiText text="Your action" /></h2>
            <div className="lending-group-tabs">
              <button disabled={busy || !!pending || adminBlocked} aria-pressed={group === "save"} className={group === "save" ? "primary" : ""}
                onClick={() => { setGroup("save"); change("supply"); }}><UiText text="Supply / Withdraw" /></button>
              <button disabled={busy || !!pending || adminBlocked} aria-pressed={group === "borrow"} className={group === "borrow" ? "primary" : ""}
                onClick={() => { setGroup("borrow"); change("deposit_collateral"); }}><UiText text="Borrow / Repay" /></button>
            </div>
            {group === "borrow" && data && data.market.price_fresh !== "true" && <div className="warning" role="status">Price feed expired. Borrowing is paused until a fresh update. Repayment remains available.</div>}
            <p className="muted">{group === "save" ? "Supply RTD to the pool, or withdraw your supplied balance when liquidity is available." : "1. Deposit RTM collateral → 2. Borrow RTD → 3. Repay → 4. Withdraw collateral."}</p>
            {!pending && <div className="lending-action-tabs" role="group" aria-label="Lending action">
              {actions.filter(a => group === "save" ? ["supply","withdraw"].includes(a) : !["supply","withdraw"].includes(a)).map(a => <button key={a} type="button" aria-pressed={a===action} disabled={busy || !!preview || adminBlocked} onClick={()=>change(a)}><UiText text={({supply:"Supply",withdraw:"Withdraw",borrow:"Borrow",repay:"Repay",deposit_collateral:"Deposit collateral",withdraw_collateral:"Withdraw collateral"})[a]} /></button>)}
            </div>}
            {!pending && <div className="lending-steps" aria-label="Transaction steps">
              {allowanceStep && <div className={!needsApproval && amountIsPositive ? "step complete" : "step"}><span>{!needsApproval && amountIsPositive ? "✓" : "1"}</span><div><strong><UiText text={`Approve ${symbol}`} /></strong><small><UiText text={!needsApproval && amountIsPositive ? "Allowance available · checked again before signing" : "Permission only · funds stay in your wallet"} /></small></div></div>}
              <div className="step current"><span>{allowanceStep ? "2" : "1"}</span><div><strong><UiText text={actionNames[action]} /></strong><small><UiText text={allowanceStep ? "Separate transaction · moves funds" : "Review first · sign in your wallet"} /></small></div></div>
            </div>}
            {!preview && !pending && <>
            <div className="lending-amount-label"><label htmlFor="lending-amount"><UiText text="Amount" /></label><span title={shownAvailable === null ? "Balance unavailable" : `${shownAvailable} ${selectedUnit}`}><UiText text={action === "withdraw" ? "Your supplied balance" : action === "borrow" || action === "withdraw_collateral" ? "Available for this action" : "Wallet balance"} />: {shownAvailable===null ? "—" : shortAmount(shownAvailable)} {selectedUnit}</span></div>
            <div className="lending-amount-box"><input
              id="lending-amount"
              value={editingAmount ? amount : displayAmount(amount)}
              title={amount}
              onFocus={() => setEditingAmount(true)}
              onBlur={() => setEditingAmount(false)}
              aria-describedby="lending-amount-help"
              inputMode="decimal"
              placeholder="0"
              onChange={(e) => {
                setAmount(e.target.value);
                setUseMax(false);
                setPreview(null);
              }}
              disabled={busy}
            /><span>{selectedUnit}</span></div>
            <div className="lending-presets">
              {[25, 50, 75, 100].map((percent) => (
                <button key={percent} type="button" disabled={busy || !!pending || adminBlocked}
                  onClick={() => selectPercent(percent)}>
                  {percent === 100 ? "Max" : `${percent}%`}
                </button>
              ))}
            </div>
            <p id="lending-amount-help" className="muted"><UiText text="Display shortened to 4 decimals. Focus to edit the exact amount; transaction precision is retained." /></p>
            {useMax && <p className="lending-inline-note"><UiText text={action === "withdraw_collateral" ? "Max withdrawable · interest margin retained" : "Max selects the full position"} /></p>}
            <div className="lending-review-summary">
              <div><span><UiText text={actionNames[action]} /></span><strong>{amountIsPositive ? shortAmount(amount) : "—"} {selectedUnit}</strong></div>
              {estimate && <div><span><UiText text={estimate.key === "supplied" ? "Estimated supplied balance after" : estimate.key === "collateral" ? "Estimated collateral after" : "Estimated debt after"} /></span><strong>≈ {shortAmount(estimate.value)} {selectedUnit}</strong></div>}
              <div><span><UiText text="Network fee" /></span><span><UiText text="Paid in RTM · shown in wallet" /></span></div>
            </div>
            <div className="lending-cta-row">
            <button onClick={refresh} disabled={busy}>
              <UiText text="Refresh position" />
            </button>
            <button
              className="primary"
              onClick={review}
              disabled={busy || !!pending || adminBlocked}
            >
              <UiText text={busy ? "Checking…" : nextLabel} />
            </button></div>
            <p className="muted"><UiText text="Prepare reads the latest position. Only Confirm & sign opens your wallet." /></p>
            </>}
            {notice && <p role="status" aria-live="polite" className="status lending-notice">{notice}</p>}
            {lastTx && <div className="lending-tx-panel confirmed"><div className="lending-panel-heading"><strong><UiText text="Transaction status" /></strong><span className="lending-badge"><UiText text="Confirmed" /></span></div><p><UiText text="HardFinal · execution OK" /></p><div className="lending-tx-links"><CopyValue value={lastTx} compact /><Link href={`/explorer?tx=${lastTx}`}><UiText text="View in Explorer" /></Link></div></div>}
            {preview && (
              <div className="preview lending-sign-review">
                <h3>{preview.plan.approval ? `Approve ${symbol}` : actionLabel}</h3>
                <p style={{ fontSize: 22, fontWeight: 700 }}>{shortAmount(preview.displayAmount || amount)} {action.includes("collateral") && !preview.plan.approval ? "RTM" : symbol}</p>
                <p>{preview.plan.approval ? "This only grants token permission. After confirmation, continue with the lending action." : action === "repay" ? "Repayment includes accrued interest and can increase slightly before execution." : "Confirm this amount and the selected wallet in the signing window."}</p>
                <details><summary>Technical details / exact amount</summary>
                  <p>{preview.displayAmount} {action.includes("collateral") && !preview.plan.approval ? "RTM" : symbol}</p>
                  {preview.plan.summary.map((line, i) => <p key={i}>{line}</p>)}
                  <code>{preview.plan.call.method}({preview.plan.call.args.join(", ")})</code>
                  <p>Attached RTM: {fmt(BigInt(preview.plan.call.amountAtomic))}</p>
                </details>
                <button className="primary lending-sign-button" onClick={execute} disabled={busy}>
                  <UiText text="Confirm & sign" />
                </button>
                <button onClick={() => setPreview(null)}>
                  <UiText text="Back" />
                </button>
              </div>
            )}
            {pending && (
              <div className="preview lending-tx-panel">
                <div className="lending-panel-heading"><strong><UiText text="Transaction status" /></strong><span className="lending-badge"><UiText text={pending.txId ? "Checking" : "Needs verification"} /></span></div>
                <div className="lending-tx-progress"><span className={pending.txId ? "done" : ""}><UiText text="Submitted" /></span><span aria-hidden="true">→</span><span className="current"><UiText text="Verify execution" /></span><span aria-hidden="true">→</span><span>HardFinal</span></div>
                <p className="lending-inline-note"><UiText text="A submitted or uncertain transaction is saved. Do not send it twice." /></p>
                {pending.txId ? (
                  <CopyValue value={pending.txId} compact />
                ) : (
                  <input
                    aria-label="Recovery TX ID"
                    value={recoveryTx}
                    placeholder="tx_…"
                    onChange={(e) => setRecoveryTx(e.target.value)}
                  />
                )}
                <button onClick={check} disabled={busy}>
                  <UiText text="Check transaction" />
                </button>
                <Link href="/dex">
                  <UiText text="Back to DEX" />
                </Link>
              </div>
            )}
          </section>
          <aside className="lending-card lending-position-card">
            <h2>
              <UiText text="Your position" />
            </h2>
            {data ? (
              <>
                {health?.label === "No debt" ? <div className="lending-health lending-health-empty"><div className="lending-amount-label"><span>Health Factor</span><span className="lending-badge"><UiText text="No debt" /></span></div><p className="muted"><UiText text="No outstanding loan. Health Factor appears when you borrow." /></p></div> : health && <div className={`lending-health ${health.tone}`}><div className="lending-amount-label"><span>Health Factor</span><span className="lending-badge"><UiText text={health.label} /></span></div><strong className="lending-health-number">{health.value}</strong><div className="lending-health-track" role="meter" aria-label="Health Factor display, capped at 3" aria-valuemin={0} aria-valuemax={3} aria-valuenow={Number((health.percent*3/100).toFixed(2))} aria-valuetext={health.label === "No debt" ? "No debt" : `${health.value}; ${health.label}`}><span style={{left:`${health.percent}%`}} /></div><div className="lending-health-scale"><span><UiText text="At risk" /></span><span><UiText text="Caution" /></span><span><UiText text="Healthy" /></span></div><p className="muted"><UiText text="Liquidation below 1.00. Caution below 1.50 is a UI guide, not a contract threshold." /></p></div>}
                <div className="lending-position-stats">
                  <div><span><UiText text="Supplied" /></span><strong>{shortAmount(fmt(BigInt(data.position.supplied)))} <small>{symbol}</small></strong></div>
                  <div><span><UiText text="Collateral" /></span><strong>{shortAmount(fmt(BigInt(data.position.collateral)))} <small>RTM</small></strong></div>
                  <div><span><UiText text="Debt" /></span><strong>{shortAmount(fmt(BigInt(data.position.debt)))} <small>{symbol}</small></strong></div>
                  <div><span>Borrow APR</span><strong>{displayAmount(fmt(BigInt(data.market.borrow_apr_bps || "500") * 10n ** 16n),2)}<small>%</small></strong></div>
                </div>
                <dl className="lending-market-stats">
                  <dt><UiText text="Available liquidity" /></dt><dd>{shortAmount(fmt(BigInt(data.market.cash)))} {symbol}</dd>
                  <dt>LTV / liquidation</dt><dd>{Number(data.market.ltv_bps || "5000")/100}% / {Number(data.market.liquidation_bps || "7000")/100}%</dd>
                  <dt><UiText text="Price status" /></dt><dd><span className={`lending-status-dot ${data.market.price_fresh === "true" ? "ok" : "warn"}`} /><UiText text={data.market.price_fresh === "true" ? "Fresh" : "Expired"} /></dd>
                  <dt><UiText text="Market" /></dt><dd><span className={`lending-status-dot ${data.market.paused === "0" ? "ok" : "warn"}`} /><UiText text={data.market.paused === "0" ? "Active" : "Paused"} /></dd>
                </dl>
                <details><summary><UiText text="Exact balances" /></summary>
                  <p>Supplied: {fmt(BigInt(data.position.supplied))} {symbol}</p>
                  <p>Collateral: {fmt(BigInt(data.position.collateral))} RTM</p>
                  <p>Debt: {fmt(BigInt(data.position.debt))} {symbol}</p>
                  <p>Liquidity: {fmt(BigInt(data.market.cash))} {symbol}</p>
                </details>
                <p className="muted">
                  <UiText text="Withdrawals require available liquidity." />
                </p>
              </>
            ) : (
              <p>
                <UiText text="Refresh to load your position." />
              </p>
            )}
            <details><summary><UiText text="Contract addresses" /></summary>
            <p className="muted">
              <UiText text="Market contract" />
            </p>
            <CopyValue value={config.market} />
            <p className="muted">
              <UiText text="Debt asset contract" />
            </p>
            <CopyValue value={config.asset} /></details>
          </aside>
        </div>
      )}

      {config?.enabled && data?.market.oracle_mode === "safehouse_reference_feed" && (wallet === PRICE_OWNER || wallet === data.market.oracle) && <SafehouseRefresh key={wallet + config.market} config={config} wallet={wallet} chain={Number(account?.chainId)} oracle={data.market.oracle} disabled={busy || !!pending || !!preview} onBlocked={setAdminBlocked} onFresh={setData} />}
      {config?.enabled && data?.market.oracle_mode === "admin_test_feed" && wallet === PRICE_OWNER && <PriceAdmin key={wallet + config.market} config={config} wallet={wallet} chain={Number(account?.chainId)} disabled={busy || !!pending || !!preview}
        onBlocked={setAdminBlocked} onFresh={setData} />}
      <p className="muted">
        <UiText text="Testnet prototype; not audited. Payments and DEX use their existing independent contracts." />
      </p>
    </main>
  );
}

const PRICE_OWNER = "retef25ddec9d77f15810718a59551061df10024179bc6da4952432f236448575a88cb37";
type PriceTx = { wallet: string; market: string; nonce: number; txId: string };
function PriceAdmin({ config, wallet, chain, disabled, onBlocked, onFresh }: {
  config: LendingConfig; wallet: string; chain: number; disabled: boolean;
  onBlocked: (value: boolean) => void; onFresh: (value: Snapshot) => void;
}) {
  const key = `retium-pay:price-update:${wallet}:${config.market}`;
  const [ready, setReady] = useState<{ nonce: number; until: number } | null>(null);
  const [saved, setSaved] = useState<PriceTx | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [recoveryId, setRecoveryId] = useState("");
  const lock = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    Promise.resolve().then(() => {
      if (!live.current) return;
      try {
        const value = JSON.parse(localStorage.getItem(key) || "null");
        if (value?.wallet === wallet && value?.market === config.market && Number.isSafeInteger(value.nonce)) {
          setSaved(value); setMessage("Saved price update restored. Check it before signing another update.");
        }
      } catch { setMessage("Could not restore price update. Check wallet history before sending."); }
    });
    return () => { live.current = false; onBlocked(false); };
  }, [key, wallet, config.market, onBlocked]);
  useEffect(() => { onBlocked(busy || !!saved); }, [busy, saved, onBlocked]);
  async function prepare() {
    if (disabled || lock.current || saved || chain !== 3) return;
    lock.current = true; setBusy(true); setReady(null);
    try {
      const fresh = await snapshot(config, wallet);
      if (!live.current) return;
      if (wallet !== PRICE_OWNER || fresh.market.owner !== wallet) throw Error("Only the verified market owner may set the test price.");
      onFresh(fresh);
      setReady({ nonce: fresh.nonce, until: Date.now() + 60000 });
      setMessage("Confirm simulated price: 1 RTM = 1 RTD, valid for 15 minutes. Network gas applies. This is not a live market price.");
    } catch (e) { if (live.current) setMessage(error(e)); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  }
  async function sign() {
    if (!ready || saved || disabled || lock.current) return;
    if (Date.now() > ready.until) { setReady(null); setMessage("Preparation expired. Prepare again."); return; }
    lock.current = true; setBusy(true);
    let hold: PriceTx | null = null;
    try {
      if (chain !== 3 || wallet !== PRICE_OWNER || !window.retium) throw Error("Owner wallet on Retium testnet required.");
      hold = { wallet, market: config.market, nonce: ready.nonce, txId: "" };
      localStorage.setItem(key, JSON.stringify(hold)); setSaved(hold); setReady(null);
      // Open the popup in this click gesture, before any await.
      const result = await window.retium.request({ method: "retium_call", params: {
        contractId: config.market, method: "set_price", args: ["1000000000000000000"], amountAtomic: "0"
      } }) as { txId?: string };
      if (!/^tx_[0-9a-f]{32}$/.test(result?.txId || "")) throw Error("No usable TX ID. Check wallet history before signing again.");
      hold = { ...hold, txId: result.txId! }; localStorage.setItem(key, JSON.stringify(hold));
      if (live.current) { setSaved(hold); setMessage("Price update submitted. Checking execution automatically…"); }
    } catch (e) {
      const code = String((e as {code?: unknown})?.code || "");
      if (hold && ["4001", "4300", "4100", "4101", "4102", "4200", "-32602"].includes(code)) {
        localStorage.removeItem(key); if (live.current) setSaved(null);
      }
      if (live.current) setMessage(error(e));
    } finally { lock.current = false; if (live.current) setBusy(false); }
  }
  const check = useCallback(async () => {
    if (!saved || lock.current) return;
    const id = saved.txId || recoveryId.trim();
    if (!/^tx_[0-9a-f]{32}$/.test(id)) { setMessage("Paste the TX ID from wallet history. Do not repeat an uncertain update."); return; }
    lock.current = true; setBusy(true);
    try {
      const tx = await readPublic(`transaction/${id}`);
      if (!live.current) return;
      if (tx.tx_id !== id || tx.sender !== wallet || tx.recipient !== config.market || tx.action !== "call" ||
          tx.call?.method !== "set_price" || tx.amount !== "0" || tx.nonce !== saved.nonce)
        throw Error("TX does not match the saved price update.");
      if ((tx.finality || tx.status) === "HardFinal" && tx.exec_status === "ok" && !tx.exec_error && !tx.rejection_reason) {
        localStorage.removeItem(key); setSaved(null);
        setMessage("Price update successful · HardFinal. Refreshing position…");
        const fresh = await snapshot(config, wallet);
        if (live.current) { onFresh(fresh); setMessage(fresh.market.price_fresh === "true" ? "Test price is Fresh. Return to Borrow above." : "TX confirmed, but the price is now expired. Prepare another refresh if required."); }
      } else if (tx.exec_error || tx.rejection_reason || ["Rejected", "Failed", "Voided"].includes(tx.finality || tx.status) ||
          ((tx.finality || tx.status) === "HardFinal" && tx.exec_status !== "ok")) {
        localStorage.removeItem(key); setSaved(null); setMessage("Price update failed. Review the TX before preparing again.");
      } else {
        const hold = { ...saved, txId: id }; localStorage.setItem(key, JSON.stringify(hold)); setSaved(hold);
        setMessage("Waiting for final execution. Do not submit another update.");
      }
    } catch (e) { if (live.current) setMessage(error(e)); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  }, [saved, recoveryId, wallet, config, key, onFresh]);
  useEffect(() => {
    if (!saved?.txId) return;
    const timer = setInterval(() => { if (!document.hidden) void check(); }, 8000);
    return () => clearInterval(timer);
  }, [saved, check]);
  return <section className="lending-card" style={{marginTop: 18}}>
    <h3>Test price administration · Quản trị giá test</h3>
    <p>Giá mô phỏng: <strong>1 RTM = 1 RTD</strong> · Hiệu lực 15 phút. Chỉ ví quản trị mới cập nhật được. Mỗi lần cần ký ví và trả gas.</p>
    {!saved && !ready && <button onClick={prepare} disabled={disabled || busy || chain !== 3}>Prepare price refresh / Chuẩn bị cập nhật giá</button>}
    {ready && !saved && <><button className="primary" onClick={sign} disabled={disabled || busy}>Confirm &amp; sign / Xác nhận và ký</button>
      <button onClick={() => setReady(null)} disabled={busy}>Cancel</button></>}
    {saved && <>{saved.txId ? <CopyValue value={saved.txId} /> : <input value={recoveryId} onChange={(e) => setRecoveryId(e.target.value)} placeholder="TX ID from wallet history" />}
      <button onClick={check} disabled={busy}>Check price TX / Kiểm tra TX cập nhật giá</button></>}
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}
