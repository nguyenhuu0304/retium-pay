import { UNIT, units, maximum, atomic, type Pool } from "./math";
export type FundingInput = {
  action: string;
  amount: string;
  tokenAmount: string;
  bps: number;
  balanceRtm: string;
  balanceToken: string;
  pool: Pool | null;
};
export function assessFunding(i: FundingInput) {
  if (!["add", "create"].includes(i.action)) return null;
  const balanceRtm = atomic(i.balanceRtm),
    balanceToken = atomic(i.balanceToken);
  let attached = 0n,
    requiredToken: bigint | null = null;
  try {
    attached = units(i.amount);
  } catch {
    if (balanceToken !== 0n || !["", "0"].includes(i.amount.trim()))
      return null;
  }
  if (i.action === "add") {
    if (!i.pool || !Number.isInteger(i.bps) || i.bps < 10 || i.bps > 500)
      return null;
    const r = atomic(i.pool.reserve_rtm),
      t = atomic(i.pool.reserve_token);
    if (r <= 0n || t <= 0n) return null;
    if (attached > 0n)
      requiredToken = maximum((attached * t + r - 1n) / r, i.bps);
  } else {
    try {
      requiredToken = units(i.tokenAmount);
    } catch {
      /* Still explain an empty token balance before its amount is entered. */
    }
  }
  const requiredRtm = attached + UNIT,
    rtmShort = requiredRtm > balanceRtm ? requiredRtm - balanceRtm : 0n;
  const tokenShort =
    requiredToken !== null && requiredToken > balanceToken
      ? requiredToken - balanceToken
      : 0n;
  const zeroToken = balanceToken === 0n;
  return {
    attached,
    requiredToken,
    requiredRtm,
    balanceRtm,
    balanceToken,
    rtmShort,
    tokenShort,
    zeroToken,
    hasPool: !!i.pool,
    canBuyToken: !!i.pool && balanceRtm > UNIT,
    canSellToken: !!i.pool && balanceToken > 0n && balanceRtm >= UNIT,
    insufficient: rtmShort > 0n || tokenShort > 0n || zeroToken,
  };
}
