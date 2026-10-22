export function repayLimits(debt: bigint) {
  return { required: debt + debt / 1000000n + 2n,
    approval: debt + debt / 1000n + 2n };
}
export function collateralAvailable(p: Record<string,string>, m: Record<string,string>) {
  const collateral = BigInt(p.collateral), debt = BigInt(p.debt), price = BigInt(m.price);
  if (debt === 0n) return collateral;
  if (m.price_fresh !== "true" || price <= 0n) return 0n;
  // Keep a 0.1% debt margin for interest during signing; chain validation remains authoritative.
  const buffered = debt + debt / 1000n + 2n;
  const required = (buffered * 2n * 10n ** 18n + price - 1n) / price;
  return collateral > required ? collateral - required : 0n;
}

// Reserve roughly ten minutes of 5% APR growth while a 60s signing preview is open.
// Derive maximum principal from debt shares, accounting for contract ceil rounding.
export function borrowAvailable(p:Record<string,string>,m:Record<string,string>):bigint {
  if(m.price_fresh !== "true" || m.paused !== "0") return 0n;
  const index=BigInt(m.index),limit=BigInt(p.borrow_limit),owned=BigInt(p.debt_shares),cash=BigInt(m.cash),U=10n**18n;
  if(index<=0n || limit<=0n || cash<=0n)return 0n;
  const futureIndex=index+index/1000000n+2n;
  const totalShares=limit*U/futureIndex;
  if(totalShares<=owned)return 0n;
  const max=(totalShares-owned)*index/U;
  return max<cash?max:cash;
}
