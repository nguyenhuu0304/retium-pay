import type { Plan } from "../dex/math";
import { UNIT, units } from "../dex/math";
import type { LendingConfig } from "./config";
export const actions = [
  "supply",
  "withdraw",
  "deposit_collateral",
  "withdraw_collateral",
  "borrow",
  "repay",
] as const;
export type LendingAction = (typeof actions)[number];
export function lendingPlan(
  c: LendingConfig,
  b: Record<string, unknown>,
  now = Date.now(),
): Plan {
  if (!c.enabled) throw Error(c.reason);
  const wallet = String(b.wallet || ""),
    action = String(b.action || "");
  if (
    !/^rete[0-9a-f]{68}$/.test(wallet) ||
    !actions.includes(action as LendingAction)
  )
    throw Error("Invalid wallet or lending action.");
  const nonce = b.nonce;
  if (!Number.isSafeInteger(nonce) || Number(nonce) < 0)
    throw Error("Invalid wallet nonce.");
  let amount = units(String(b.amount || ""));
  if (amount > 10n ** 27n) throw Error("Testnet amount limit exceeded.");
  const approval = b.approval === true;
  if (approval && !["supply", "repay"].includes(action))
    throw Error("This action does not require approval.");
  if (action === "borrow" && amount < 10n ** 15n)
    throw Error("Minimum testnet loan is 0.001.");
  // Withdraw and repay use raw position shares, not token quantities. Never silently convert them.
  if (["withdraw", "repay"].includes(action)) {
    const shares = String(b.shares || "");
    if (!/^[1-9][0-9]{0,38}$/.test(shares))
      throw Error("Enter valid position shares.");
    amount = BigInt(shares);
    if (amount > 10n ** 27n) throw Error("Share limit exceeded.");
  }
  let approvalAmount = amount;
  if (approval && action === "repay") {
    const raw = String(b.maxRepayAtomic || "");
    if (!/^[1-9][0-9]{0,38}$/.test(raw))
      throw Error("Invalid repayment approval limit.");
    approvalAmount = BigInt(raw);
    if (approvalAmount > 10n ** 27n) throw Error("Approval limit exceeded.");
  }
  const call = approval
    ? {
        contractId: c.asset,
        method: "approve",
        args: [c.market, String(approvalAmount)],
        amountAtomic: "0",
      }
    : {
        contractId: c.market,
        method: action,
        args: action === "deposit_collateral" ? [] : [String(amount)],
        amountAtomic: action === "deposit_collateral" ? String(amount) : "0",
      };
  return {
    wallet,
    token: c.asset,
    symbol: c.symbol,
    action: `lending:${action}`,
    call,
    nonce: Number(nonce),
    createdAt: now,
    expiresAt: now + 60000,
    deadline: now + 120000,
    summary: [
      `Retium Pay Lending · TESTNET`,
      approval
        ? "Approval only. Return and review the lending action separately."
        : action,
      `Debt asset: ${c.symbol}`,
      `Testnet reference feed; confirm the market price source and freshness. Not a decentralized oracle.`,
      ...(action === "withdraw" || action === "repay"
        ? [`Position shares: ${amount}`]
        : [
            `Amount: ${amount / UNIT}.${String(amount % UNIT).padStart(18, "0")}`,
          ]),
    ],
    approval,
    lending: {
      market: c.market,
      marketCodeHash: c.marketCodeHash,
      asset: c.asset,
      assetCodeHash: c.assetCodeHash,
    },
  };
}

export function positionShares(owned: string, percent: string): bigint {
  if (
    !/^[0-9]{1,39}$/.test(owned) ||
    !/^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,2})?$/.test(percent)
  )
    throw Error("Enter a percentage from 0.01 to 100.");
  const [whole, fraction = ""] = percent.split(".");
  const bps = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (bps <= 0n || bps > 10000n)
    throw Error("Percentage must be greater than zero and at most 100.");
  const result = (BigInt(owned) * bps) / 10000n;
  if (result <= 0n) throw Error("No position or percentage is too small.");
  return result;
}
