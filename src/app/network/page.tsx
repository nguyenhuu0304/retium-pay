"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import "./network.css";

type Diagnostic = {
  checkedAt: string;
  node?: {
    reachable: boolean;
    status: string | null;
    version: string | null;
    tick: number | null;
    peers: number | null;
    error?: string | null;
  };
  networkIdentity?: {
    expectedChainId: number | null;
    observedChainId: number | null;
    chainIdVerified: boolean;
    expectedProtocolVersion: number | null;
    observedProtocolVersion: number | null;
    protocolVersionVerified: boolean;
    note: string;
  };
  contracts?: Record<string, {
    configured: boolean;
    deployed: boolean;
    codeHash: string | null;
    hashMatched: boolean | null;
    ready: boolean | null;
    error?: string;
  }>;
  features?: Record<string, {
    ready: boolean;
    configured?: boolean;
    mode?: string;
    reason?: string | null;
    note?: string;
  }>;
  wallet?: {
    adapter: string;
    sdkConfigured: boolean;
    methods: string[];
    note: string;
  };
  safety?: string[];
};

const statusLabel = (ok: boolean) => ok ? "Healthy" : "Needs attention";

function Status({ ok }: { ok: boolean }) {
  return (
    <span className={ok ? "network-status network-status-ok" : "network-status network-status-warn"}>
      {statusLabel(ok)}
    </span>
  );
}

export default function NetworkPage() {
  const [data, setData] = useState<Diagnostic | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/network/diagnostics", {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const result = await response.json();
      if (!response.ok && !result?.node) {
        throw new Error(result?.configurationError || "Network diagnostics are unavailable.");
      }
      setData(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load network diagnostics.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <main className="tool-page network-page">
      <header className="tool-heading">
        <div>
          <p className="eyebrow">RETIUM PAY · SYSTEM</p>
          <h1>Network health</h1>
          <p>Read-only checks for the active Retium network and each on-chain feature.</p>
        </div>
        <Link className="button secondary" href="/">Back to dashboard</Link>
      </header>

      <section className="tool-card network-overview">
        <div className="network-card-heading">
          <div>
            <h2>RPC node</h2>
            <p>{data?.node?.version ? "Node " + data.node.version : "Waiting for node response"}</p>
          </div>
          {data?.node ? <Status ok={data.node.reachable} /> : <span className="network-status">Not checked</span>}
        </div>
        <div className="network-metrics">
          <div><span>Node status</span><strong>{data?.node?.status || "—"}</strong></div>
          <div><span>Tick</span><strong>{data?.node?.tick ?? "—"}</strong></div>
          <div><span>Peers</span><strong>{data?.node?.peers ?? "—"}</strong></div>
          <div><span>Last checked</span><strong>{data?.checkedAt ? new Date(data.checkedAt).toLocaleString() : "—"}</strong></div>
        </div>
        {data?.node?.error ? <p className="network-warning">{data.node.error}</p> : null}
        <button className="button primary" type="button" onClick={() => void refresh()} disabled={busy}>
          {busy ? "Checking…" : "Run checks again"}
        </button>
        {error ? <p className="network-warning">{error}</p> : null}
      </section>

      <section className="tool-card">
        <h2>Feature availability</h2>
        <div className="network-feature-list">
          {(["payments", "dex", "lending"] as const).map((name) => {
            const feature = data?.features?.[name];
            return (
              <article className="network-feature" key={name}>
                <div className="network-card-heading">
                  <h3>{name === "dex" ? "DEX" : name === "lending" ? "Lending" : "Payments & history"}</h3>
                  {!feature ? <span className="network-status">Not checked</span> : feature.ready === null ? <span className="network-status">Independent</span> : <Status ok={feature.ready} />}
                </div>
                <p>{feature?.reason || feature?.note || (name === "payments" ? "Independent from DEX and Lending contract status." : "Requires verified contracts on the active network.")}</p>
              </article>
            );
          })}
        </div>
      </section>

      <section className="tool-card">
        <h2>Contract verification</h2>
        <div className="network-feature-list">
          {([
            ["dex", "DEX contract"],
            ["lendingMarket", "Lending market"],
            ["lendingAsset", "Lending asset"],
          ] as const).map(([key, label]) => {
            const contract = data?.contracts?.[key];
            return (
              <article className="network-feature" key={key}>
                <div className="network-card-heading">
                  <h3>{label}</h3>
                  {contract ? <Status ok={contract.ready} /> : <span className="network-status">Not checked</span>}
                </div>
                <p>{contract?.error || (contract?.hashMatched ? "Live code hash matches configured hash." : "No verified contract result.")}</p>
                <code>{contract?.codeHash || "Code hash unavailable"}</code>
              </article>
            );
          })}
        </div>
      </section>

      <section className="tool-card">
        <h2>Network identity</h2>
        <div className="network-metrics">
          <div><span>Expected chain ID</span><strong>{data?.networkIdentity?.expectedChainId ?? "—"}</strong></div>
          <div><span>Observed chain ID</span><strong>{data?.networkIdentity?.observedChainId ?? "Not exposed"}</strong></div>
          <div><span>Expected payload version</span><strong>{data?.networkIdentity?.expectedProtocolVersion ?? "—"}</strong></div>
          <div><span>Observed payload version</span><strong>{data?.networkIdentity?.observedProtocolVersion ?? "Not exposed"}</strong></div>
        </div>
        <p className="network-muted">{data?.networkIdentity?.note || "Network identity verification details are unavailable."}</p>
      </section>

      <section className="tool-card">
        <h2>Wallet adapter</h2>
        <p>{data?.wallet?.note || "Wallet capability status unavailable."}</p>
        <div className="network-methods">{(data?.wallet?.methods || []).map((method) => <code key={method}>{method}</code>)}</div>
      </section>

      <p className="network-muted">All checks are read-only. This page never signs, submits, deploys, or changes feature flags. Payment history remains independent from DEX and Lending health.</p>
    </main>
  );
}
