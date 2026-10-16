export {};
declare global {
  interface Window {
    retium?: {
      request(input: {
        method: string;
        params?: Record<string, unknown>;
      }): Promise<unknown>;
    };
  }
}
