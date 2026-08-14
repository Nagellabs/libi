import { NextResponse } from "next/server";
import { getAnalyticsSettings, getOrCreateAnalyticsUserId } from "@/lib/db/settings";
import { ANALYTICS_ENABLED } from "@/lib/analytics/config";

export async function GET(): Promise<Response> {
  const userId = getOrCreateAnalyticsUserId();
  const enabled = ANALYTICS_ENABLED && getAnalyticsSettings().enabled;
  return NextResponse.json({ userId, enabled });
}
