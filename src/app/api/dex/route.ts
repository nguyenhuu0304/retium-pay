import { NextResponse } from "next/server";
import {
  prepareDeploy,
  stakeSummary,
  pools,
  prepare,
  tokenPage,
  marketSummary,
} from "../../../lib/dex/server";
export async function GET(request: Request) {
  try {
    const u = new URL(request.url);
    if (u.searchParams.get("view") === "stake")
      return NextResponse.json(
        await stakeSummary(u.searchParams.get("wallet") || ""),
        { headers: { "Cache-Control": "no-store" } },
      );
    if (u.searchParams.get("view") === "tokens")
      return NextResponse.json(
        await tokenPage(
          u.searchParams.get("cursor") || "0",
          Number(u.searchParams.get("offset") || "0"),
        ),
        { headers: { "Cache-Control": "no-store" } },
      );
    if (u.searchParams.get("view") === "market")
      return NextResponse.json(
        await marketSummary(
          u.searchParams.get("token") || "",
          u.searchParams.get("wallet") || "",
        ),
        { headers: { "Cache-Control": "no-store" } },
      );
    return NextResponse.json(await pools(u.searchParams.get("cursor") || "0"), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "DEX read failed." },
      { status: 400 },
    );
  }
}
export async function POST(request: Request) {
  try {
    if (
      request.headers.get("origin") !==
      new URL(process.env.APP_URL || "http://localhost:3000").origin
    )
      return NextResponse.json(
        { error: "Request origin is not allowed." },
        { status: 403 },
      );
    const text = await request.text();
    if (text.length > 15000) throw Error("Request too large.");
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw Error("Invalid request.");
    if (body.operation === "prepareDeploy")
      return NextResponse.json(await prepareDeploy(body), {
        headers: { "Cache-Control": "no-store" },
      });
    if (body.operation === "prepare")
      return NextResponse.json(await prepare(body), {
        headers: { "Cache-Control": "no-store" },
      });

    throw Error("Unknown operation.");
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "DEX request failed." },
      { status: 400 },
    );
  }
}
