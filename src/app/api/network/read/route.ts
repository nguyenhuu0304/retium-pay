import { NextResponse } from "next/server";
import { rpcGet, validateRetiumReadPath } from "../../../../lib/rpc/client";
import { DEX } from "../../../../lib/dex/math";
import { assertFeatureReady } from "../../../../lib/network/health";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const path = validateRetiumReadPath(url.searchParams.get("path") || "");
    if (
      path.startsWith(`contract/${DEX}/query?method=`) &&
      /method=(?:list_pools|get_pool|get_lp_balance)&/.test(path)
    ) {
      await assertFeatureReady("dex");
    }
    const data = await rpcGet(path);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Retium read failed.";
    const status = /Unsupported Retium read endpoint/.test(message) ? 400 : /health check|disabled|verification|code hash|network/i.test(message) ? 503 : 502;
    return NextResponse.json(
      { error: message },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
