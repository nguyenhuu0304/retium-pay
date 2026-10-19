// Deliberately exclude messages, URLs, connection strings and stack traces.
export function safeWorkerError(error) {
  const raw = error?.code ?? error?.cause?.code;
  const code = typeof raw === "string" && /^[A-Z0-9_]{2,40}$/.test(raw) ? raw : null;
  if (code) return `code=${code}`;
  const name = error?.name;
  return ["TimeoutError", "AbortError", "TypeError", "SyntaxError"].includes(name) ? name : "operation failed";
}
