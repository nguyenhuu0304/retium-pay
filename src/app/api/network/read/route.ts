import { NextResponse } from "next/server";
import { rpcGet, validateRetiumReadPath } from "../../../../lib/rpc/client";
import { DEX } from "../../../../lib/dex/math";
import { WHISK_DEX } from "../../../../lib/dex/pool-read";
import { assertFeatureReady } from "../../../../lib/network/health";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const path = validateRetiumReadPath(url.searchParams.get("path") || "");
    const dexRead = new RegExp(
      `^contract/(?:${DEX}|${WHISK_DEX})/query\\?method=(?:list_pools|get_pool|list_v2|get_v2|get_lp_balance)&`,
    );
    if (dexRead.test(path)) await assertFeatureReady("dex");
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
