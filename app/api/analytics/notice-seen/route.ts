import { NextResponse } from "next/server";
import { getAnalyticsSettings, setAnalyticsSettings } from "@/lib/db/settings";

export async function GET(): Promise<Response> {
  return NextResponse.json({ shown: getAnalyticsSettings().firstRunNoticeShown });
}

export async function POST(): Promise<Response> {
  setAnalyticsSettings({ firstRunNoticeShown: true });
  return NextResponse.json({ ok: true });
}
