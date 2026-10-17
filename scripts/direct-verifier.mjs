// Execute the existing trusted backend verifier on the worker host.
// No HTTP listener, browser-provided receipt, wallet key or transaction signing.
import { registerHooks } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import ts from "typescript";

export async function createDirectVerifier(project) {
  const sourceRoot = path.join(project, "src") + path.sep;
  const isSource = (url) => {
    try { return url?.startsWith("file:") && fileURLToPath(url).startsWith(sourceRoot); }
    catch { return false; }
  };
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (isSource(context.parentURL)) {
        if (specifier === "next/server") return nextResolve("next/server.js", context);
        if (specifier.startsWith(".")) {
          const url = new URL(specifier, context.parentURL);
          const name = fileURLToPath(url);
          if (!path.extname(name) && existsSync(name + ".ts"))
            return { url: pathToFileURL(name + ".ts").href, shortCircuit: true };
        }
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (isSource(url) && url.endsWith(".ts")) {
        const source = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
          compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
        }).outputText;
        return { source, format: "module", shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
  const { POST } = await import(pathToFileURL(path.join(project, "src/app/api/payments/route.ts")).href);
  return async function tick(key) {
    return POST(new Request("http://worker.internal/api/payments", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Retium-Worker-Key": key },
      body: JSON.stringify({ action: "workerTick" }),
    }));
  };
}
