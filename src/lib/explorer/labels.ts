// Presentation labels belong to Retium Pay; never rewrite the upstream transaction.
const tradingContract =
  "a8a370858f29a78c07dd115a7ef123d93e1e3ef1caa3bb7c27565c8ffb14945c";
const methods: Record<string, string> = {
  swap: "Swap",
  add_liquidity: "Add liquidity",
  create_pool: "Create pool",
  remove_liquidity: "Remove liquidity",
  lock_liquidity: "Lock liquidity",
  approve: "Token approval",
  transfer: "Token transfer",
  transfer_from: "Token transfer",
};
export function displayAction(tx: Record<string, unknown>) {
  const call = tx.call as Record<string, unknown> | null;
  const method = typeof call?.method === "string" ? call.method : "";
  if (tx.action === "call" && method) {
    const label =
      tx.recipient === tradingContract ||
      ["approve", "transfer", "transfer_from"].includes(method)
        ? methods[method]
        : undefined;
    return `Retium Pay · ${label || `Contract call (${method})`}`;
  }
  const native: Record<string, string> = {
    transfer: "Transfer",
    deploy: "Deploy contract",
    stake: "Stake",
    unstake: "Unstake",
    api_key: "API key",
  };
  const action = typeof tx.action === "string" ? tx.action : "Unknown action";
  return `Retium Pay · ${native[action] || action}`;
}
