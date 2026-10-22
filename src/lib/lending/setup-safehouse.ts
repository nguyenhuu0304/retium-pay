export const SETUP_OWNER =
  "retef25ddec9d77f15810718a59551061df10024179bc6da4952432f236448575a88cb37";
export const SETUP_HASH =
  "0eb5be7eed26b9a5105a007f2f9e81352e451bad6f79a45f320c725b65c0dbe0";
export const SETUP_ASSET =
  "c1d3885930a23a099e28e6f55f8ee8d8908902b57a7ef9d28de6756819d5611c";
export const SETUP_ASSET_HASH =
  "5c6b3392d5f3769522befe48cb5dc53db3e633e2f3a63f29abba74433ef768a2";
export const SETUP_METADATA = {
  rcp_type: "retiumpay_lending_test",
  traits: ["testnet", "lending", "safehouse_reference_feed"],
  capabilities: ["execute"],
  lockable_fields: [],
  evolves_from: "",
  weight: 5,
  version: "v0.2.0",
};
export function checkedSetupTx(
  tx: Record<string, unknown>,
  id: string,
  stage: "deploy" | "init",
  market: string,
) {
  if (tx.tx_id !== id || tx.sender !== SETUP_OWNER)
    throw Error("Transaction does not belong to the selected owner wallet.");
  if (stage === "init" && tx.recipient !== market)
    throw Error("Wrong lending contract.");
  if (tx.action !== (stage === "deploy" ? "deploy" : "call"))
    throw Error("Wrong transaction action.");
  if (tx.amount !== "0")
    throw Error("Setup must not attach RTM; only network fees are allowed.");
  if (
    ["Rejected", "Failed", "Voided"].includes(String(tx.finality || tx.status))
  )
    return "failed";
  if ((tx.finality || tx.status) !== "HardFinal") return "pending";
  if (tx.exec_error || tx.rejection_reason || tx.exec_status !== "ok")
    return "failed";
  if (stage === "init") {
    const c = tx.call as {
      contract?: unknown;
      method?: unknown;
      args?: unknown;
    };
    if (c?.contract !== market || c?.method !== "init")
      throw Error("Wrong initialization method.");
    if (c.args !== undefined) {
      const a = Array.isArray(c.args) ? c.args.map(String).join(",") : c.args;
      if (a !== [SETUP_ASSET, SETUP_ASSET_HASH].join(","))
        throw Error("Wrong initialization asset.");
    }
  }
  return "confirmed";
}
