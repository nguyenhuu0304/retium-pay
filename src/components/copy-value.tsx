"use client";
import { useState } from "react";
import { UiText } from "./preferences";

export function CopyValue({ value, compact = false }: { value: string; compact?: boolean }) {
  const [status, setStatus] = useState("");
  return <span style={{ overflowWrap: "anywhere" }}>
    <button type="button" title="Copy" aria-label={`Copy ${value}`} style={{ background: "transparent", color: "inherit", border: 0, padding: 0, font: "inherit", textAlign: "left", cursor: "copy", overflowWrap: "anywhere", maxWidth: "100%" }} onClick={async () => {
      try { await navigator.clipboard.writeText(value); setStatus("Copied"); }
      catch { setStatus("Copy failed; select and copy manually."); }
    }}><code>{compact && value.length > 28 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value}</code></button>
    <small role="status" aria-live="polite" style={{ marginLeft: 8 }}><UiText text={status} /></small>
  </span>;
}
