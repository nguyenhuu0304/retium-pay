import { createHash } from "node:crypto";

export type RequestDetails = {
  id: string;
  recipient: string;
  payer: string;
  amountRtm: string;
  amountAtomic: string;
  description: string;
  createdAt: number;
  payerLabel?: string;
  payerTelegram?: { displayName: string; username: string };
  notifyTelegram?: boolean;
};

export function detailsHash(payment: RequestDetails) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: 1,
        purpose: "retium-pay-request",
        chainId: 3,
        id: payment.id,
        recipient: payment.recipient,
        payer: payment.payer,
        amountRtm: payment.amountRtm,
        amountAtomic: payment.amountAtomic,
        description: payment.description,
        createdAt: payment.createdAt,
        ...(payment.payerLabel ? { payerLabel: payment.payerLabel } : {}),
        ...(payment.payerTelegram
          ? { payerTelegram: payment.payerTelegram }
          : {}),
        ...(payment.notifyTelegram === undefined
          ? {}
          : { notifyTelegram: payment.notifyTelegram }),
      }),
      "utf8",
    )
    .digest("hex");
}

export function requestStatement(payment: RequestDetails) {
  const text = `Create Retium Pay testnet request: ${payment.amountRtm} RTM. Details SHA-256: ${detailsHash(payment)}. This signature does not transfer funds.`;
  if (text.length > 256) throw new Error("Statement exceeds Wallet limit.");
  return text;
}

export function authorizeStatement(payment: RequestDetails, nonce: number) {
  const text = `Retium Pay testnet: authorize ${payment.amountRtm} RTM. Nonce ${nonce}. Details SHA-256: ${detailsHash(payment)}. Separate transfer approval required.`;
  if (text.length > 256) throw new Error("Statement exceeds Wallet limit.");
  return text;
}

export function validateTransfer(
  tx: Record<string, unknown>,
  payment: RequestDetails,
  expectedNonce: number,
  txId: string,
) {
  if (tx.tx_id !== txId) throw new Error("The RPC returned a different TX ID.");
  if (tx.finality === "Rejected" || tx.finality === "Voided") {
    throw new Error(
      `Transaction ${String(tx.finality)}. No payment confirmed.`,
    );
  }
  if (tx.finality !== "HardFinal") return false;
  if (tx.status != null && tx.status !== "HardFinal") {
    throw new Error("Transaction finality fields disagree.");
  }
  if (tx.action !== "transfer" || tx.call != null) {
    throw new Error("This is not a direct RTM transfer.");
  }
  if (tx.sender !== payment.payer || tx.recipient !== payment.recipient) {
    throw new Error("The transaction sender or recipient does not match.");
  }
  if (payment.payer === payment.recipient)
    throw new Error("Self-payment is not supported.");
  if (
    typeof tx.amount !== "string" ||
    !/^\d+$/.test(tx.amount) ||
    BigInt(tx.amount) !== BigInt(payment.amountAtomic)
  ) {
    throw new Error("The transaction amount does not match the request.");
  }
  if (!Number.isSafeInteger(tx.nonce) || tx.nonce !== expectedNonce) {
    throw new Error(
      "The transaction nonce does not match the authorized payment. Do not send again; check the TX.",
    );
  }
  // Native transfers legitimately return exec_status: null.
  if (
    (tx.exec_status != null && tx.exec_status !== "ok") ||
    tx.exec_error != null ||
    tx.rejection_reason != null
  ) {
    throw new Error("The transaction reports an execution error.");
  }
  if (
    typeof tx.timestamp !== "number" ||
    !Number.isSafeInteger(tx.timestamp) ||
    tx.timestamp * 1000 < payment.createdAt - 30_000 ||
    tx.timestamp * 1000 > Date.now() + 60_000
  ) {
    throw new Error(
      "The transaction time is invalid or predates this request.",
    );
  }
  return true;
}
