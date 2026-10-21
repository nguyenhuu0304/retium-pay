export const DEX =
  "a8a370858f29a78c07dd115a7ef123d93e1e3ef1caa3bb7c27565c8ffb14945c";
export const UNIT = 10n ** 18n;
export type Pool = {
  token_b: string;
  reserve_rtm: string;
  reserve_token: string;
  lp_supply: string;
};
export type Call = {
  contractId: string;
  method: string;
  args: string[];
  amountAtomic: string;
};
export type Plan = {
  lending?: { market: string; marketCodeHash: string; asset: string; assetCodeHash: string };
  deployment?: { codeHash: string; metadata: Record<string, unknown> };
  wallet: string;
  token: string;
  symbol: string;
  action: string;
  call: Call;
  nonce: number;
  createdAt: number;
  expiresAt: number;
  deadline: number;
  summary: string[];
  approval: boolean;
};
export function units(text: string) {
  if (!/^(0|[1-9][0-9]{0,19})(\.[0-9]{1,18})?$/.test(text))
    throw Error("Enter a positive decimal with at most 18 decimal places.");
  const [whole, fraction = ""] = text.split(".");
  const n = BigInt(whole) * UNIT + BigInt(fraction.padEnd(18, "0"));
  if (n <= 0n) throw Error("Amount must be greater than zero.");
  return n;
}
export function decimalAtomic(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,39})(\.[0-9]{1,18})?$/.test(value)
  )
    throw Error("RPC returned an invalid decimal balance.");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * UNIT + BigInt(fraction.padEnd(18, "0"));
}
export function atomic(value: unknown) {
  if (typeof value !== "string" || !/^[0-9]{1,90}$/.test(value))
    throw Error("Invalid atomic amount returned by RPC.");
  return BigInt(value);
}
export function fmt(n: bigint) {
  return `${n / UNIT}${n % UNIT ? "." + (n % UNIT).toString().padStart(18, "0").replace(/0+$/, "") : ""}`;
}
export function sqrt(n: bigint) {
  if (n < 0n) throw Error("Negative square root.");
  if (n < 2n) return n;
  let x = n,
    y = (n + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
export function minimum(n: bigint, bps: number) {
  return (n * BigInt(10000 - bps)) / 10000n;
}
export function maximum(n: bigint, bps: number) {
  return (n * BigInt(10000 + bps) + 9999n) / 10000n;
}
export function output(input: bigint, reserveIn: bigint, reserveOut: bigint) {
  if (input <= 0n || reserveIn <= 0n || reserveOut <= 0n)
    throw Error("Pool has no usable liquidity.");
  return (input * 997n * reserveOut) / (reserveIn * 1000n + input * 997n);
}
export function makePlan(input: {
  wallet: string;
  token: string;
  symbol: string;
  action: string;
  direction: string;
  amount: string;
  tokenAmount: string;
  shares: string;
  lockDays: string;
  bps: number;
  pool: Pool | null;
  balanceRtm: bigint;
  balanceToken: bigint;
  allowance: bigint;
  lp: bigint;
  locked: bigint;
  untilMs: number;
  nonce: number;
  now: number;
}): Plan {
  const i = input,
    b = i.bps;
  if (!Number.isInteger(b) || b < 10 || b > 500)
    throw Error("Slippage must be between 0.10% and 5.00%.");
  const deadline = i.now + 20 * 60_000;
  const p = i.pool,
    r = p ? atomic(p.reserve_rtm) : 0n,
    t = p ? atomic(p.reserve_token) : 0n,
    supply = p ? atomic(p.lp_supply) : 0n;
  let method = "",
    args: string[] = [],
    attached = 0n,
    requiredToken = 0n;
  const summary: string[] = [];
  if (i.action === "swap") {
    if (!p) throw Error("No pool exists for this token.");
    const amount = units(i.amount),
      rtm = i.direction === "RTM_TO_TOKEN";
    if (!rtm && i.direction !== "TOKEN_TO_RTM")
      throw Error("Invalid swap direction.");
    const expected = output(amount, rtm ? r : t, rtm ? t : r),
      min = minimum(expected, b);
    if (min <= 0n) throw Error("Trade is too small.");
    method = "swap";
    args = [
      i.token,
      amount.toString(),
      i.direction,
      min.toString(),
      String(deadline),
    ];
    attached = rtm ? amount : 0n;
    requiredToken = rtm ? 0n : amount;
    summary.push(
      `Pay: ${fmt(amount)} ${rtm ? "RTM" : i.symbol}`,
      `Estimated receive: ${fmt(expected)} ${rtm ? i.symbol : "RTM"}`,
      `Minimum receive: ${fmt(min)} ${rtm ? i.symbol : "RTM"}`,
    );
    const impact = (amount * 10000n) / ((rtm ? r : t) + amount);
    if (impact >= 1000n)
      throw Error("Price impact is at least 10%. Reduce the trade size.");
    summary.push(
      `Pool fee: 0.3% of input. Price impact estimate: ${Number(impact) / 100}%.`,
    );
  } else if (i.action === "add") {
    if (!p || r <= 0n || t <= 0n || supply <= 0n)
      throw Error("Use Create pool for a new token pair.");
    const amount = units(i.amount),
      expectedToken = (amount * t + r - 1n) / r,
      cap = maximum(expectedToken, b),
      lp = (amount * supply) / r,
      min = minimum(lp, b);
    if (min <= 0n) throw Error("Liquidity amount is too small.");
    method = "add_liquidity";
    args = [
      i.token,
      amount.toString(),
      cap.toString(),
      min.toString(),
      String(deadline),
    ];
    attached = amount;
    requiredToken = cap;
    summary.push(
      `Deposit: ${fmt(amount)} RTM`,
      `Token estimate: ${fmt(expectedToken)} ${i.symbol}`,
      `Token maximum: ${fmt(cap)} ${i.symbol}`,
      `Minimum LP shares: ${fmt(min)}`,
    );
  } else if (i.action === "create") {
    if (p) throw Error("A pool already exists. Use Add liquidity.");
    const amount = units(i.amount),
      tokens = units(i.tokenAmount),
      lp = sqrt(amount * tokens) - 1000n;
    if (lp <= 0n) throw Error("Initial liquidity is too small.");
    method = "create_pool";
    args = [i.token, amount.toString(), tokens.toString()];
    attached = amount;
    requiredToken = tokens;
    summary.push(
      `Initial deposit: ${fmt(amount)} RTM + ${fmt(tokens)} ${i.symbol}`,
      `You set the initial price. Estimated LP: ${fmt(lp)}`,
      "This creates a public pool. Check the initial ratio carefully.",
    );
  } else if (i.action === "remove") {
    if (!p || supply <= 0n) throw Error("Pool unavailable.");
    const shares = units(i.shares);
    if (shares > i.lp - i.locked) throw Error("Not enough unlocked LP shares.");
    const mr = minimum((r * shares) / supply, b),
      mt = minimum((t * shares) / supply, b);
    if (mr <= 0n || mt <= 0n) throw Error("Withdrawal is too small.");
    method = "remove_liquidity";
    args = [
      i.token,
      shares.toString(),
      mr.toString(),
      mt.toString(),
      String(deadline),
    ];
    summary.push(
      `Burn LP shares: ${fmt(shares)}`,
      `Minimum receive: ${fmt(mr)} RTM + ${fmt(mt)} ${i.symbol}`,
    );
  } else if (i.action === "lock") {
    const shares = units(i.shares),
      days = Number(i.lockDays);
    if (shares > i.lp || shares < i.locked)
      throw Error(
        "Lock total must be between current locked shares and total LP.",
      );
    if (!Number.isInteger(days) || days < 1 || days > 3650)
      throw Error("Choose a lock duration from 1 to 3650 days.");
    const until = i.now + days * 86400_000;
    if (i.locked > 0n && (i.untilMs === 0 || until < i.untilMs))
      throw Error(
        "An active lock cannot be shortened; permanent locks cannot be replaced.",
      );
    method = "lock_liquidity";
    args = [i.token, shares.toString(), String(until)];
    summary.push(
      `Total locked LP after this call: ${fmt(shares)}`,
      `Lock until: ${new Date(until).toISOString()}`,
      "Locked shares cannot be withdrawn before this date.",
    );
  } else throw Error("Unsupported DEX action.");
  if (i.balanceToken < requiredToken) throw Error("Not enough token balance.");
  // A reserve is a buffer, not a guaranteed network fee quote.
  if (i.balanceRtm < attached + UNIT)
    throw Error(
      "Keep at least 1 RTM beyond the attached amount as a network-fee buffer.",
    );
  const approval = requiredToken > i.allowance;
  const call = approval
    ? {
        contractId: i.token,
        method: "approve",
        args: [DEX, requiredToken.toString()],
        amountAtomic: "0",
      }
    : { contractId: DEX, method, args, amountAtomic: attached.toString() };
  if (approval)
    summary.unshift(
      `First approve ${fmt(requiredToken)} ${i.symbol} for the trading contract used by Retium Pay. Refresh the preview after approval confirms.`,
    );
  return {
    wallet: i.wallet,
    token: i.token,
    symbol: i.symbol,
    action: i.action,
    call,
    nonce: i.nonce,
    createdAt: i.now,
    expiresAt: i.now + 60_000,
    deadline,
    summary,
    approval,
  };
}

