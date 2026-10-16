import { NextResponse } from "next/server";
import { explorerLookup } from "../../../lib/explorer/read";
export async function GET(request: Request) {
  try {
    const u = new URL(request.url);
    return NextResponse.json(
      await explorerLookup(
        u.searchParams.get("q") || "",
        Number(u.searchParams.get("offset") || 0),
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Explorer lookup failed." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
