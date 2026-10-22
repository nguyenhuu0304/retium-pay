"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { blake3 } from "@noble/hashes/blake3.js";
import { useSharedWallet } from "../../../components/shared-wallet";
import { CopyValue } from "../../../components/copy-value";
import { readPublic } from "../../../lib/lending/browser";
import {
  SETUP_OWNER,
  SETUP_HASH,
  SETUP_ASSET,
  SETUP_ASSET_HASH,
  SETUP_METADATA,
  checkedSetupTx,
} from "../../../lib/lending/setup-safehouse";
import "../lending.css";
import { SafehouseOwnerActions } from "./owner-actions";
type State = {
  market: string;
  deployTx: string;
  verified: boolean;
  initialized: boolean;
  stage: "deploy" | "init" | "";
  txId: string;
  unknown: boolean;
};
const empty: State = {
  market: "",
  deployTx: "",
  verified: false,
  initialized: false,
  stage: "",
  txId: "",
  unknown: false,
};
const key = "retium-pay:lending-setup-safehouse:owner37:v2";
const hex = /^[0-9a-f]{64}$/,
  txPattern = /^tx_[0-9a-f]{32}$/;
const msg = (e: unknown) => {
  if (e && typeof e === "object") {
    const raw = e as { code?: unknown; message?: unknown };
    const text =
      typeof raw.message === "string"
        ? raw.message.slice(0, 700)
        : "Wallet request failed.";
    return `${raw.code === undefined ? "" : `[${String(raw.code)}] `}${text}`;
  }
  return typeof e === "string" ? e.slice(0, 700) : "Wallet request failed.";
};
type Prepared = {
  stage: "deploy" | "init";
  params: Record<string, unknown>;
  expiresAt: number;
};
export default function Setup() {
  const { account, ready } = useSharedWallet(),
    [state, setState] = useState<State>(empty),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [txInput, setTxInput] = useState(""),
    [accepted, setAccepted] = useState(false),
    [prepared, setPrepared] = useState<Prepared | null>(null),
    [lastError, setLastError] = useState(""),
    [marketActive, setMarketActive] = useState<boolean | null>(null);
  const lock = useRef(false);
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => {
      if (!live) return;
      try {
        const s = JSON.parse(localStorage.getItem(key) || "null");
        if (s) {
          if (
            typeof s.market !== "string" ||
            (s.market && !hex.test(s.market)) ||
            !["deploy", "init", ""].includes(s.stage) ||
            typeof s.txId !== "string" ||
            (s.txId && !txPattern.test(s.txId))
          )
            throw Error();
          setState({ ...empty, ...s, verified: false, initialized: false });
        }
        setLoaded(true);
      } catch {
        setNotice(
          "Saved setup cannot be read. Do not deploy again; inspect wallet history first.",
        );
      }
    });
    return () => {
      live = false;
    };
  }, []);
  function save(s: State) {
    localStorage.setItem(key, JSON.stringify(s));
    setState(s);
  }
  async function signer() {
    if (!window.retium) throw Error("Wallet SDK is not ready.");
    const a = (await window.retium.request({
      method: "retium_requestAccounts",
    })) as { address?: string; chainId?: number };
    if (a.address !== SETUP_OWNER || Number(a.chainId) !== 3)
      throw Error("Select wallet ending a88cb37 on Retium testnet (chain 3).");
    return window.retium;
  }
  async function verifyMarket(market: string) {
    const c = await readPublic(`contract/${market}`);
    if (
      c.contract_id !== market ||
      c.code_hash !== SETUP_HASH ||
      c.deployer !== SETUP_OWNER ||
      c.rcp_metadata?.rcp_type !== "retiumpay_lending_test" ||
      c.rcp_metadata?.version !== "v0.2.0"
    )
      throw Error(
        "Market code or deployer does not match. Do not fund or initialize it.",
      );
    return c;
  }
  async function owner(market: string) {
    const q = await readPublic(`contract/${market}/query?method=owner&args=`);
    if (
      q.contract_id !== market ||
      q.method !== "owner" ||
      q.ok !== true ||
      typeof q.output !== "string"
    )
      throw Error("Owner verification unavailable.");
    const r = JSON.parse(q.output);
    if (r.ok !== true || r.data !== SETUP_OWNER)
      throw Error("Owner differs from wallet 37. Do not send funds.");
    return true;
  }
  async function prepare(stage: "deploy" | "init") {
    if (lock.current || !loaded || state.stage || !accepted) return;
    lock.current = true;
    setBusy(true);
    setPrepared(null);
    setLastError("");
    try {
      // This account request runs directly from the prepare click. It is NOT a deployment.
      await signer();
      let params: Record<string, unknown>;
      if (stage === "deploy") {
        if (state.deployTx || state.market)
          throw Error(
            "A deployment is already saved. Verify it rather than deploying again.",
          );
        const r = await fetch("/contracts/retium_lending_safehouse.wasm", {
          cache: "no-store",
          signal: AbortSignal.timeout(12000),
        });
        if (!r.ok)
          throw Error(
            "Lending WASM is missing. Reinstall the testnet package.",
          );
        const bytes = new Uint8Array(await r.arrayBuffer());
        const hash = Array.from(blake3(bytes), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
        if (hash !== SETUP_HASH) throw Error("WASM code hash mismatch.");
        let raw = "";
        for (const b of bytes) raw += String.fromCharCode(b);
        params = { wasmBase64: btoa(raw), metadata: SETUP_METADATA };
      } else {
        if (!state.verified || !state.market || state.initialized)
          throw Error("Verify the deployed contract first.");
        await verifyMarket(state.market);
        // Never interpret an RPC error as proof that init has not happened.
        try {
          await owner(state.market);
          save({ ...state, initialized: true });
          setNotice(
            "Owner already verified as wallet 37. No initialization was sent.",
          );
          return;
        } catch (e) {
          if (msg(e).includes("Owner differs")) throw e;
          const pristine = await verifyMarket(state.market);
          if (pristine.storage_keys_count !== 0) throw Error("Không xác minh được owner hoặc contract không còn trống. Không gửi init.");
        }
        const a = await readPublic(`contract/${SETUP_ASSET}`);
        if (a.contract_id !== SETUP_ASSET || a.code_hash !== SETUP_ASSET_HASH)
          throw Error("RTD code hash differs from the inspected asset.");
        params = {
          contractId: state.market,
          method: "init",
          args: [SETUP_ASSET, SETUP_ASSET_HASH],
          amountAtomic: "0",
        };
      }
      setPrepared({ stage, params, expiresAt: Date.now() + 60_000 });
      setNotice(
        `Đã kiểm tra ví 37 và chuẩn bị ${stage}. Chưa gửi giao dịch. Bấm nút Ký ${stage} bên dưới để mở đúng cửa sổ giao dịch.`,
      );
    } catch (e) {
      setLastError(msg(e));
      setNotice("Chuẩn bị chưa hoàn tất; chưa gọi gửi giao dịch.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function execute() {
    if (lock.current || !prepared || !loaded || state.stage || !accepted)
      return;
    lock.current = true;
    setBusy(true);
    setLastError("");
    let hold: State | null = null;
    try {
      if (account?.address !== SETUP_OWNER || Number(account.chainId) !== 3)
        throw Error("Select wallet 37 on testnet chain 3.");
      if (Date.now() > prepared.expiresAt) {
        setPrepared(null);
        throw Error("Bản chuẩn bị hết hạn. Chuẩn bị lại trước khi ký.");
      }
      const provider = window.retium;
      if (!provider) throw Error("Wallet SDK is not ready.");
      hold = { ...state, stage: prepared.stage, txId: "", unknown: true };
      save(hold);
      const operation = prepared.stage;
      const params = prepared.params;
      setPrepared(null);
      // No await, fetch, account request or timer before this wallet request.
      // SDK 1.3.0 opens its popup synchronously, inside this signature-button gesture.
      const waiting = provider.request({
        method: operation === "deploy" ? "retium_deploy" : "retium_call",
        params,
      });
      const result = (await waiting) as { txId?: string; contractId?: string };
      if (!txPattern.test(result?.txId || ""))
        throw Error(
          "Ví chưa trả TX ID hợp lệ. Kiểm tra lịch sử ví; không gửi lại.",
        );
      save({ ...hold, txId: result.txId!, unknown: false });
      setNotice(
        "Đã gửi TX. Bấm Kiểm tra TX / Owner để kiểm tra HardFinal. Không gửi lại giao dịch.",
      );
    } catch (e) {
      if (
        hold &&
        ["4001", "4300", "4100", "4101", "4102", "4200", "-32602"].includes(
          String((e as { code?: unknown })?.code),
        )
      )
        save({ ...state, stage: "", txId: "", unknown: false });
      setLastError(msg(e));
      setNotice(
        hold
          ? "Nếu ví đã ký nhưng chưa trả TX, lấy TX ID từ lịch sử ví để kiểm tra. Không tự gửi lại."
          : "Chưa gọi gửi giao dịch.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function check() {
    if (lock.current || !loaded) return;
    if (!state.stage && (!state.market || !state.deployTx)) {
      setNotice(
        "Chưa có TX deploy đã lưu. Xem thông báo lỗi bên dưới; kiểm tra TX không mở cửa sổ ký.",
      );
      return;
    }
    lock.current = true;
    setBusy(true);
    try {
      const id = state.txId || txInput.trim();
      if (!state.stage) {
        if (!state.market || !state.deployTx)
          throw Error("No saved deployment.");
        const tx = await readPublic(`transaction/${state.deployTx}`);
        if (checkedSetupTx(tx, state.deployTx, "deploy", "") !== "confirmed")
          throw Error("Deployment is not confirmed.");
        if (tx.recipient !== state.market) throw Error("Wrong saved market.");
        await verifyMarket(state.market);
        let initialized = false;
        try {
          initialized = await owner(state.market);
        } catch (e) {
          if (msg(e).includes("Owner differs")) throw e;
        }
        if (initialized) {
          const rawMarket = await readPublic(`contract/${state.market}/query?method=market&args=`);
          if(rawMarket.ok !== true) throw Error("Market status unavailable.");
          const currentMarket = JSON.parse(rawMarket.output);
          if(currentMarket.owner !== SETUP_OWNER || currentMarket.version !== "v0.2.0") throw Error("Unexpected market state.");
          setMarketActive(currentMarket.paused === "0");
        }
        save({ ...state, verified: true, initialized });
        setNotice(
          initialized
            ? "Contract and owner verified as wallet 37. Read the current market status below."
            : "Deployment verified. You may explicitly initialize it. Never fund before verifying the owner.",
        );
        return;
      }
      if (!txPattern.test(id))
        throw Error("Paste the TX ID from wallet history.");
      const tx = await readPublic(`transaction/${id}`);
      const status = checkedSetupTx(tx, id, state.stage, state.market);
      if (status === "pending") {
        setNotice("Awaiting finality. You can leave and return later.");
        return;
      }
      if (status === "failed") {
        save({ ...state, stage: "", txId: "", unknown: false });
        setNotice(
          "Transaction failed; no successful setup operation was confirmed.",
        );
        return;
      }
      if (state.stage === "deploy") {
        const market = String(tx.recipient || "");
        if (!hex.test(market))
          throw Error("Deployment contract ID unavailable.");
        await verifyMarket(market);
        save({
          ...state,
          market,
          deployTx: id,
          verified: true,
          stage: "",
          txId: "",
          unknown: false,
        });
        setNotice(
          "Deploy verified: HardFinal, execution ok, code hash and deployer match wallet 37. Next: initialize, then verify owner before any funding.",
        );
      } else {
        await verifyMarket(state.market);
        await owner(state.market);
        const q = await readPublic(
          `contract/${state.market}/query?method=market&args=`,
        );
        if (q.ok !== true || typeof q.output !== "string")
          throw Error("Market query unavailable.");
        const m = JSON.parse(q.output);
        if (
          m.version !== "v0.2.0" ||
          m.oracle_mode !== "safehouse_reference_feed" ||
          m.owner !== SETUP_OWNER ||
          m.asset !== SETUP_ASSET ||
          m.asset_hash !== SETUP_ASSET_HASH ||
          m.paused !== "1"
        )
          throw Error("Unexpected initial market configuration.");
        save({
          ...state,
          initialized: true,
          verified: true,
          stage: "",
          txId: "",
          unknown: false,
        });
        setNotice(
          "Init verified. Owner is wallet 37; inspected RTD configured; market paused. Save the IDs and continue to the small token compatibility test.",
        );
      }
    } catch (e) {
      setNotice(msg(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <main className="lending-page">
      <p className="eyebrow">RETIUM PAY · TESTNET OWNER SETUP</p>
      <h1>Thiết lập Lending Safehouse v0.2</h1>
      <p>
        Ký trực tiếp qua Retium Web Wallet. Deploy và init là hai giao dịch
        riêng, có phí testnet.
      </p>
      <section className="lending-card">
        <p>Ví chủ sở hữu bắt buộc:</p>
        <CopyValue value={SETUP_OWNER} />
        <p className="muted">
          Ví đang chọn:{" "}
          {account?.address === SETUP_OWNER
            ? "Đúng ví 37"
            : account
              ? "Sai ví"
              : "Chưa chọn ví"}
        </p>
        {account?.address !== SETUP_OWNER && (
          <Link href="/">Về Dashboard để chọn ví 37</Link>
        )}
        <p className="warning">
          {state.initialized ? "Owner đã xác minh đúng ví 37. Tỷ lệ tham chiếu Safehouse 1 RTM = 1 RTD, cập nhật bằng ví publisher riêng." : "Chỉ nạp sau khi init đạt HardFinal và xác minh owner đúng ví 37. Tỷ lệ tham chiếu Safehouse 1 RTM = 1 RTD."}
          {marketActive !== null && <strong> Market: {marketActive ? "Active" : "Paused"}.</strong>}
        </p>
        <label>
          <input
            type="checkbox"
            style={{ width: "auto", marginRight: 8 }}
            checked={accepted}
            onChange={(e) => {
              setAccepted(e.target.checked);
              setPrepared(null);
            }}
          />
          Tôi hiểu đây là deploy testnet có phí, và đã đối chiếu RTD trên Retium
          Money.
        </label>
        <p className="muted">RTD ID đang dùng:</p>
        <CopyValue value={SETUP_ASSET} />
        <p className="muted">Code hash Lending:</p>
        <CopyValue value={SETUP_HASH} />
        <button
          className="primary"
          onClick={() => prepare("deploy")}
          disabled={
            !ready ||
            !loaded ||
            busy ||
            !!state.stage ||
            !!state.market ||
            !!state.deployTx ||
            !accepted ||
            account?.address !== SETUP_OWNER
          }
        >
          1. Chuẩn bị deploy Lending
        </button>
        <button
          onClick={() => prepare("init")}
          disabled={
            busy ||
            !loaded ||
            !accepted ||
            !!state.stage ||
            !state.verified ||
            state.initialized ||
            account?.address !== SETUP_OWNER
          }
        >
          2. Chuẩn bị init bằng ví 37
        </button>
        {prepared && (
          <div className="preview">
            <p>
              Đã kiểm tra ví đuôi 37. Kiểm tra lại tài khoản và phí ở cửa sổ ký
              tiếp theo. Bản chuẩn bị có hiệu lực 60 giây.
            </p>
            <button
              className="primary"
              onClick={execute}
              disabled={busy || !accepted || !!state.stage}
            >
              Ký{" "}
              {prepared.stage === "deploy" ? "deploy Lending" : "init Lending"}{" "}
              trong ví
            </button>
            <button onClick={() => setPrepared(null)} disabled={busy}>
              Hủy bản chuẩn bị
            </button>
          </div>
        )}
        <button onClick={check} disabled={busy || !loaded}>
          Kiểm tra TX / Owner
        </button>
        {state.stage && (
          <>
            <p>
              Đang theo dõi: {state.stage}.{" "}
              {state.txId ? <CopyValue value={state.txId} /> : null}
            </p>
            {!state.txId && (
              <input
                placeholder="Dán TX ID từ lịch sử ví nếu ví không trả kết quả"
                aria-label="Recovery TX ID"
                value={txInput}
                onChange={(e) => setTxInput(e.target.value)}
              />
            )}
          </>
        )}
        {state.market && (
          <>
            <h2>Contract đã lưu</h2>
            <CopyValue value={state.market} />
            <p>
              Owner:{" "}
              {state.initialized
                ? "Đã xác minh đúng ví 37"
                : "Chờ xác minh sau init"}
            </p>
          </>
        )}
        {state.initialized && state.market && <SafehouseOwnerActions market={state.market} wallet={account?.address || ""} chain={Number(account?.chainId)} onMarketState={setMarketActive} />}
        {lastError && (
          <p role="alert" className="warning">
            Lỗi cụ thể: {lastError}
          </p>
        )}
        <p role="status" aria-live="polite" className="status">
          {notice}
        </p>
        <p className="muted">
          Không cần nhập private key, seed hoặc file .sk. Kết quả được kiểm tra
          bằng API công khai từ trình duyệt; chưa có thông báo Telegram tự động
          cho bước thiết lập này.
        </p>
        <Link href="/lending">Quay lại Lending</Link>
      </section>
    </main>
  );
}
