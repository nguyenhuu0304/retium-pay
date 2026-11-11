import { NextResponse } from "next/server";
import { rpcGet, validateRetiumReadPath } from "../../../../lib/rpc/client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const path = validateRetiumReadPath(url.searchParams.get("path") || "");
    const data = await rpcGet(path);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Retium read failed.";
    const status = /Unsupported Retium read endpoint/.test(message) ? 400 : 502;
    return NextResponse.json(
      { error: message },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
