import { NextResponse } from "next/server";
import { getSettings, updateSettings, type AppSettings } from "@/lib/db/settings";

export async function GET() {
  const settings = getSettings();
  return NextResponse.json({ settings });
}

export async function PATCH(request: Request) {
  const body: Partial<AppSettings> = await request.json();
  updateSettings(body);
  const settings = getSettings();
  return NextResponse.json({ settings });
}
