export {};
declare global {
  interface Window {
    retium?: {
      request(input: {
        method:
          | "retium_requestAccounts"
          | "retium_signAuth"
          | "retium_sendTransfer"
          | "retium_call"
          | "retium_deploy";
        params?: Record<string, unknown>;
      }): Promise<unknown>;
    };
  }
}
