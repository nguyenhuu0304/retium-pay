import type { Plan } from "../dex/math";
export type VerificationJob = {txId: string;wallet: string;plan: Plan};
export function verifyDexTx(tx: Record<string, unknown>, j: VerificationJob) {
  const finality = tx.finality || tx.status;
  if (tx.tx_id !== j.txId || tx.sender !== j.wallet || tx.recipient !== j.plan.call.contractId || tx.nonce !== j.plan.nonce || tx.amount !== j.plan.call.amountAtomic || tx.action !== (j.plan.deployment ? "deploy" : "call"))
    throw Error("Transaction identity differs from the prepared request.");
  if (!j.plan.deployment) {
    const c = tx.call as {contract?: unknown; method?: unknown; args?: unknown} | null;
    if (c?.contract !== j.plan.call.contractId || c?.method !== j.plan.call.method) throw Error("Contract call differs from the prepared request.");
    if(c.args !== undefined) {
      const args = Array.isArray(c.args) ? c.args.map(String).join(",") : c.args;
      if(args !== j.plan.call.args.join(",")) throw Error("Contract arguments differ from the prepared request.");
    }
  }
  if (["Rejected", "Voided", "Failed"].includes(String(finality))) return "failed";
  if (finality !== "HardFinal") return "pending";
  if (j.plan.deployment) {
    if (
      tx.tx_id !== j.txId ||
      tx.sender !== j.wallet ||
      tx.action !== "deploy" ||
      tx.recipient !== j.plan.call.contractId ||
      tx.nonce !== j.plan.nonce ||
      tx.amount !== "0"
    )
      throw Error("Deployment does not match the preview. Check the Explorer.");
    if (
      typeof tx.timestamp !== "number" ||
      !Number.isSafeInteger(tx.timestamp) ||
      tx.timestamp * 1000 < j.plan.createdAt - 30_000 ||
      tx.timestamp * 1000 > Date.now() + 60_000
    )
      throw Error("Unexpected deployment timestamp.");
    if (
      tx.exec_error ||
      tx.rejection_reason ||
      (tx.exec_status && tx.exec_status !== "ok")
    )
      return "failed";
    if (tx.exec_status !== "ok")
      throw Error(
        "Deployment execution status is not available yet. Check the Explorer.",
      );
    return "confirmed";
  }
  if (
    tx.tx_id !== j.txId ||
    tx.sender !== j.wallet ||
    tx.action !== "call" ||
    tx.recipient !== j.plan.call.contractId ||
    tx.nonce !== j.plan.nonce
  )
    throw Error(
      "Transaction does not match the prepared contract call. Review in the Explorer.",
    );
  const call = tx.call as {
    contract?: string;
    method?: string;
    args?: unknown;
  } | null;
  if (
    call?.contract !== j.plan.call.contractId ||
    call?.method !== j.plan.call.method ||
    tx.amount !== j.plan.call.amountAtomic
  )
    throw Error("Contract, method or attached RTM does not match the preview.");
  if (call?.args !== undefined) {
    const args = Array.isArray(call.args)
      ? call.args.map(String).join(",")
      : call.args;
    if (args !== j.plan.call.args.join(","))
      throw Error("Contract arguments do not match the preview.");
  }
  const timestamp = tx.timestamp;
  if (
    typeof timestamp !== "number" ||
    !Number.isSafeInteger(timestamp) ||
    timestamp * 1000 < j.plan.createdAt - 30_000 ||
    timestamp * 1000 > Date.now() + 60_000
  )
    throw Error("Unexpected transaction timestamp.");
  if (tx.exec_error || tx.rejection_reason) return "failed";
  if (tx.exec_status && tx.exec_status !== "ok") return "failed";
  if (tx.exec_status !== "ok") return "pending";
  return "confirmed";
}
