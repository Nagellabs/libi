import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { getAnalyticsSettings, setAnalyticsSettings } from "@/lib/db/settings";
import { applyOptIn, applyOptOut } from "@/lib/analytics/settings-logic";
import { trackServerEvent } from "@/lib/analytics/server";

export async function GET(): Promise<Response> {
  const s = getAnalyticsSettings();
  return NextResponse.json({ enabled: s.enabled, optOutAt: s.optOutAt });
}

const bodySchema = z.object({ enabled: z.boolean() });

export async function PUT(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const cur = getAnalyticsSettings();
  if (cur.enabled && !parsed.data.enabled) {
    // Disabling: record the opt-out on the server transport BEFORE the DB flag
    // flips (trackServerEvent checks that flag), then persist the opt-out.
    const optOutAt = Date.now();
    await trackServerEvent("analytics_opt_out", { opted_out_at: optOutAt });
    const next = setAnalyticsSettings(applyOptOut(cur, optOutAt));
    return NextResponse.json({ enabled: next.enabled, optOutAt: next.optOutAt });
  }
  if (!cur.enabled && parsed.data.enabled) {
    const next = setAnalyticsSettings(applyOptIn(cur));
    void trackServerEvent("analytics_opt_in");
    return NextResponse.json({ enabled: next.enabled, optOutAt: next.optOutAt });
  }
  return NextResponse.json({ enabled: cur.enabled, optOutAt: cur.optOutAt });
}
