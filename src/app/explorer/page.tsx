"use client";
import { CopyValue } from "../../components/copy-value";
import { displayAction } from "../../lib/explorer/labels";
import { useCallback, useEffect, useRef, useState } from "react";
import { explorerLookup, type ExplorerResult } from "../../lib/explorer/browser";
import { UiText, UiInput } from "../../components/preferences";
import "./explorer.css";
const show = (x: unknown) =>
  typeof x === "string" || typeof x === "number" ? String(x) : "—";
function Field({ label, value }: { label: string; value: unknown }) {
  const text = show(value);
  return (
    <div className="explorer-field">
      <dt>
        <UiText text={label} />
      </dt>
      <dd>
        {label === "Action" ? <code><UiText text={text} /></code> : text !== "—" && text.length > 24 ? <CopyValue value={text} /> : <code>{text}</code>}
      </dd>
    </div>
  );
}
export default function Explorer() {
  const [q, setQ] = useState(""),
    [result, setResult] = useState<ExplorerResult | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  const lookup = useCallback(async (query: string, offset = 0) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const data = await explorerLookup(query, offset);
      setResult(data);
      setQ(query.trim());
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : "Explorer lookup failed.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    const txId = new URL(window.location.href).searchParams.get("tx");
    if (txId && /^tx_[a-f0-9]{32}$/.test(txId)) void Promise.resolve().then(() => lookup(txId));
  }, [lookup]);
  const tx = result?.kind === "transaction" ? result.record : null;
  return (
    <main className="explorer-page">
      <header>
        <p className="eyebrow">RETIUM PAY · EXPLORER</p>
        <h1>
          <UiText text={"Retium Pay Explorer"} />
        </h1>
        <p>
          <UiText
            text={
              "Search public transactions, wallets and contracts. No wallet connection required."
            }
          />
        </p>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void lookup(q);
        }}
        className="explorer-search"
      >
        <UiInput
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="TX ID, wallet address or contract ID"
          aria-label="Explorer search"
        />
        <button className="button primary" disabled={busy || !q.trim()}>
          <UiText text={busy ? "Searching…" : "Search"} />
        </button>
      </form>
      {error && (
        <p role="alert" className="notice">
          <UiText text={error} />
        </p>
      )}
      {result && (
        <section className="explorer-panel">
          <h2>
            <UiText
              text={
                result.kind === "transaction"
                  ? "Transaction details"
                  : result.kind === "wallet"
                    ? "Wallet details"
                    : "Contract details"
              }
            />
          </h2>
          <p className="explorer-muted">
            <UiText text={"Read at:"} />{" "}
            {new Date(result.fetchedAt).toLocaleString()}
          </p>
          {tx ? (
            <>
              <dl className="explorer-fields">
                <Field label="Transaction ID" value={tx.tx_id} />
                <Field label="Action" value={displayAction(tx)} />
                <Field label="Finality" value={tx.finality || tx.status} />
                <Field label="Execution status" value={tx.exec_status} />
                <Field label="Sender" value={tx.sender} />
                <Field label="Recipient" value={tx.recipient} />
                <Field label="Attached RTM" value={tx.amount_rtm} />
                <Field label="Block" value={tx.block_id} />
                <Field label="Tick" value={tx.tick} />
                <Field label="Nonce" value={tx.nonce} />
                <Field
                  label="Time"
                  value={
                    typeof tx.timestamp === "number"
                      ? new Date(tx.timestamp * 1000).toLocaleString()
                      : null
                  }
                />
              </dl>
              {tx.exec_error != null && (
                <p className="notice">{show(tx.exec_error)}</p>
              )}
              <p className="explorer-muted">
                <UiText
                  text={
                    "Attached RTM is not the swap output. Token and NFT receipt details are shown only when provided by the API."
                  }
                />
              </p>
              <details>
                <summary>
                  <UiText text={"Raw API details"} />
                </summary>
                <pre>{JSON.stringify(tx, null, 2)}</pre>
              </details>
            </>
          ) : result.kind === "wallet" ? (
            <>
              <dl className="explorer-fields">
                <Field label="Wallet" value={result.query} />
                <Field label="Balance RTM" value={result.record.balance_rtm} />
                <Field label="Spendable RTM" value={result.record.spendable} />
                <Field label="Pie balance" value={result.record.balance_pie} />
                <Field label="Next nonce" value={result.record.nonce} />
              </dl>
              <h3>
                <UiText text={"Wallet transactions"} />
              </h3>
              <p className="explorer-muted">
                <UiText
                  text={
                    "20 transactions per API page. This is not an all-time transaction count."
                  }
                />
              </p>
              {result.historyError && (
                <p role="status">
                  <UiText text={result.historyError} />
                </p>
              )}
              <div className="explorer-table">
                <table>
                  <thead>
                    <tr>
                      <th>
                        <UiText text={"Transaction ID"} />
                      </th>
                      <th>
                        <UiText text={"Action"} />
                      </th>
                      <th>
                        <UiText text={"Attached RTM"} />
                      </th>
                      <th>
                        <UiText text={"Status"} />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.transactions?.map((row, index) => (
                      <tr key={String(row.tx_id || index)}>
                        <td>
                          <button
                            className="explorer-link"
                            disabled={
                              busy || !/^tx_[0-9a-f]{32}$/.test(show(row.tx_id))
                            }
                            onClick={() => void lookup(show(row.tx_id))}
                          >
                            {show(row.tx_id)}
                          </button>
                        </td>
                        <td>
                          <UiText text={displayAction(row)} />
                        </td>
                        <td>{show(row.amount_rtm)}</td>
                        <td>{show(row.finality || row.status)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!result.historyError && !result.transactions?.length && (
                <p>
                  <UiText text={"No transactions returned on this page."} />
                </p>
              )}
              <div className="explorer-pagination">
                <button
                  className="button secondary"
                  disabled={busy || !result.offset}
                  onClick={() =>
                    void lookup(result.query, (result.offset || 0) - 20)
                  }
                >
                  <UiText text={"Previous"} />
                </button>
                <span>
                  <UiText text={"Page"} />{" "}
                  {Math.floor((result.offset || 0) / 20) + 1}
                </span>
                <button
                  className="button secondary"
                  disabled={busy || !result.hasMore}
                  onClick={() =>
                    void lookup(result.query, (result.offset || 0) + 20)
                  }
                >
                  <UiText text={"Next"} />
                </button>
              </div>
            </>
          ) : (
            <>
              <dl className="explorer-fields">
                <Field
                  label="Contract ID"
                  value={result.record.contract_id || result.query}
                />
                <Field label="Code hash" value={result.record.code_hash} />
                <Field label="Deployer" value={result.record.deployer} />
                <Field
                  label="Deployed at block"
                  value={result.record.deployed_at_block}
                />
                {result.record.owner != null && (
                  <Field label="Owner" value={result.record.owner} />
                )}
              </dl>
              <details open>
                <summary>
                  <UiText text={"Contract metadata"} />
                </summary>
                <pre>
                  {JSON.stringify(result.record.rcp_metadata || {}, null, 2)}
                </pre>
              </details>
            </>
          )}
        </section>
      )}
      <p className="explorer-muted">
        <UiText
          text={
            "Public data comes from the Retium API. Unknown or unavailable fields stay blank. Block lookup and network-wide indexing are not included yet."
          }
        />
      </p>
    </main>
  );
}

