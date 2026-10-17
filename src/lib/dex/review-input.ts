import { atomic, type Pool } from "./math";

// Browser inputs describe an intent only. Never use them as settlement evidence.
export function parseReviewSnapshot(value: unknown, token: string, wallet: string, now: number) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid review input.");
  const s = value as Record<string, unknown>;
  if (s.token !== token || s.wallet !== wallet) throw Error("Review wallet or token changed.");
  if (typeof s.readAt !== "number" || !Number.isSafeInteger(s.readAt) || s.readAt > now + 5000 || now - s.readAt > 30000)
    throw Error("Review data expired. Refresh and try again.");
  if (typeof s.nonce !== "number" || !Number.isSafeInteger(s.nonce) || s.nonce < 0)
    throw Error("Invalid review nonce.");
  if (typeof s.symbol !== "string" || !/^[A-Za-z0-9._ -]{1,40}$/.test(s.symbol) || typeof s.codeHash !== "string" || !/^[0-9a-f]{64}$/.test(s.codeHash))
    throw Error("Invalid token metadata.");
  let pool: Pool | null = null;
  if (s.pool !== null) {
    if (!s.pool || typeof s.pool !== "object" || Array.isArray(s.pool)) throw Error("Invalid pool.");
    const p = s.pool as Record<string, unknown>;
    if (p.token_b !== token) throw Error("Wrong pool token.");
    pool = { token_b: token, reserve_rtm: atomic(p.reserve_rtm).toString(), reserve_token: atomic(p.reserve_token).toString(), lp_supply: atomic(p.lp_supply).toString() };
  }
  const lp = atomic(s.lp), locked = atomic(s.locked);
  if (typeof s.untilMs !== "number" || !Number.isSafeInteger(s.untilMs) || s.untilMs < -1 || locked > lp || (locked > 0n && s.untilMs < 0))
    throw Error("Invalid LP lock state.");
  return { info: { symbol: s.symbol, codeHash: s.codeHash }, pool,
    balanceRtm: atomic(s.balanceRtm), balanceToken: atomic(s.balanceToken), allowance: atomic(s.allowance),
    lp, locked, untilMs: s.untilMs, nonce: s.nonce };
}
