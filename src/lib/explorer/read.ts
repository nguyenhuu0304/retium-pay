const base = (process.env.RETIUM_RPC_URL || "https://rpc.retium.org").replace(
  /\/$/,
  "",
);
export function classifyQuery(q: string) {
  if (/^tx_[0-9a-f]{32}$/.test(q)) return "transaction";
  if (/^rete[0-9a-f]{68}$/.test(q)) return "wallet";
  if (/^[0-9a-f]{64}$/.test(q)) return "contract";
  throw Error("Enter a valid Retium TX ID, wallet address or contract ID.");
}
async function read(endpoint: string) {
  const r = await fetch(`${base}/api/${endpoint}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
  });
  const text = await r.text();
  if (text.length > 1500000) throw Error("Explorer response is too large.");
  if (!r.ok)
    throw Error(
      r.status === 404
        ? "Not found on the current Retium network."
        : `Retium API unavailable (${r.status}). Try again later.`,
    );
  try {
    return JSON.parse(text);
  } catch {
    throw Error("Retium API returned an invalid response.");
  }
}
export async function explorerLookup(query: string, offset: number) {
  const q = query.trim().toLowerCase();
  if (q.length > 100) throw Error("Search is too long.");
  const kind = classifyQuery(q);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 1000000 ||
    offset % 20 !== 0
  )
    throw Error("Invalid history page.");
  if (kind === "transaction") {
    const tx = await read(`transaction/${q}`);
    if (!tx || tx.tx_id !== q)
      throw Error(
        "The API returned a different transaction. No result displayed.",
      );
    return { kind, query: q, record: tx, fetchedAt: Date.now() };
  }
  if (kind === "contract") {
    const c = await read(`contract/${q}`);
    if (!c || c.contract_id !== q)
      throw Error(
        "The API returned a different contract. No result displayed.",
      );
    return {
      kind,
      query: q,
      record: {
        contract_id: c.contract_id,
        code_hash: c.code_hash,
        rcp_metadata: c.rcp_metadata,
        owner: c.owner,
        deployer: c.deployer,
        deployed_at_block: c.deployed_at_block,
        status: c.status,
      },
      fetchedAt: Date.now(),
    };
  }
  const account = await read(`wallet/${q}`);
  if (!account || typeof account !== "object" || Array.isArray(account))
    throw Error("Invalid wallet response.");
  if (account.address && String(account.address).toLowerCase() !== q)
    throw Error("The API returned a different wallet. No result displayed.");
  let transactions: unknown[] = [];
  let historyError = "";
  try {
    const h = await read(`wallet/${q}/transactions?limit=20&offset=${offset}`);
    const rows = Array.isArray(h) ? h : h.transactions;
    if (!Array.isArray(rows))
      throw Error("Wallet history is not available in this API response.");
    transactions = rows.slice(0, 20);
  } catch (e) {
    historyError =
      e instanceof Error ? e.message : "Wallet history unavailable.";
  }
  return {
    kind,
    query: q,
    record: {
      address: q,
      balance_rtm: account.balance_rtm,
      spendable: account.spendable,
      balance_pie: account.balance_pie,
      nonce: account.nonce,
    },
    transactions,
    offset,
    hasMore: transactions.length === 20,
    historyError,
    fetchedAt: Date.now(),
  };
}
