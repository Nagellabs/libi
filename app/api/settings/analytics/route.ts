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
    // Enqueue the opt-out event for completeness, but be honest about what
    // this achieves: nothing. drainAnalyticsQueue purges the ENTIRE queue
    // the instant it reads enabled === false (lib/analytics/queue.ts) —
    // deliberately, on the grounds that holding events for someone who
    // opted out is the one thing a privacy toggle must not do. The flag
    // flips right after this call, synchronously, so the very next drain
    // discards this event along with everything else. No ordering of these
    // two lines changes that, and there is no second path to Google this
    // event could take instead — adding one would defeat the opt-out.
    // So: libi does not measure its own opt-out rate. By choice.
    const optOutAt = Date.now();
    trackServerEvent("analytics_opt_out", { opted_out_at: optOutAt });
    const next = setAnalyticsSettings(applyOptOut(cur, optOutAt));
    return NextResponse.json({ enabled: next.enabled, optOutAt: next.optOutAt });
  }
  if (!cur.enabled && parsed.data.enabled) {
    const next = setAnalyticsSettings(applyOptIn(cur));
    trackServerEvent("analytics_opt_in");
    return NextResponse.json({ enabled: next.enabled, optOutAt: next.optOutAt });
  }
  return NextResponse.json({ enabled: cur.enabled, optOutAt: cur.optOutAt });
}
