/**
 * Retium Web Wallet adapter.
 *
 * Keep provider method names and payloads here so wallet protocol changes
 * can be handled centrally. Calls are intentionally direct: invoke this
 * function synchronously from the user's click handler so wallet popups are
 * not blocked by an intervening network await.
 */

export const RETIUM_WALLET_SDK = {
  src: "https://wallet.retium.org/connect/sdk/retium-sdk-1.3.0.js",
  integrity: "sha384-FTG6s31+cSLKvZXfREum814s/L2AnqVyikuFQvMKIvFfAz40ksTcaXVbRmkHGGTU",
} as const;

export type RetiumWalletMethod =
  | "retium_requestAccounts"
  | "retium_signAuth"
  | "retium_sendTransfer"
  | "retium_call"
  | "retium_deploy";

export type RetiumWalletRequest = {
  method: RetiumWalletMethod;
  params?: Record<string, unknown>;
};

export type RetiumWalletProvider = {
  request(input: RetiumWalletRequest): Promise<unknown>;
};

export function getRetiumWallet(): RetiumWalletProvider | undefined {
  if (typeof window === "undefined") return undefined;
  return window.retium;
}

export function walletRequest<T = unknown>(
  method: RetiumWalletMethod,
  params?: Record<string, unknown>,
): Promise<T> {
  const wallet = getRetiumWallet();
  if (!wallet) {
    throw new Error("Retium Web Wallet is not available. Check that its SDK has loaded.");
  }

  // Do not add awaits, fetches, timers or other asynchronous work before
  // this call. Several wallet providers require the request to originate
  // directly from the user's interaction gesture.
  return wallet.request({ method, ...(params ? { params } : {}) }) as Promise<T>;
}
