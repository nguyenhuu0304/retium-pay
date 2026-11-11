import { NextResponse } from "next/server";
import { lendingConfig } from "../../../lib/lending/config";
import { lendingPlan } from "../../../lib/lending/plan";
import { issueTrackingTicket } from "../../../lib/dex/server";
import { assertFeatureReady } from "../../../lib/network/health";
export async function GET() {
  const config = lendingConfig();
  if (!config.enabled) {
    return NextResponse.json(config, {
      headers: { "Cache-Control": "no-store" },
    });
  }
  try {
    await assertFeatureReady("lending");
    return NextResponse.json(config, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({
      ...config,
      enabled: false,
      reason: error instanceof Error ? error.message : "Lending health verification failed.",
    }, { headers: { "Cache-Control": "no-store" } });
  }
}
export async function POST(request: Request) {
  try {
    if (
      request.headers.get("origin") !==
      new URL(process.env.APP_URL || "http://localhost:3000").origin
    )
      return NextResponse.json(
        { error: "Origin not allowed." },
        { status: 403 },
      );
    const raw = await request.text();
    if (raw.length > 6000) throw Error("Request too large.");
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw Error("Invalid request.");
    await assertFeatureReady("lending");
    const plan = lendingPlan(lendingConfig(), body);
    return NextResponse.json(
      { plan, ticket: await issueTrackingTicket(plan) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Lending preview failed." },
      { status: /health check|disabled|verification|code hash|network/i.test(e instanceof Error ? e.message : "") ? 503 : 400 },
    );
  }
}
