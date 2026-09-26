import { NextResponse } from "next/server";
import { getSettings, updateSettings, type AppSettings } from "@/lib/db/settings";

export async function GET() {
  const settings = getSettings();
  return NextResponse.json({ settings });
}

/**
 * The general settings patch. `agentApprovalModes` is never taken from it: the
 * approval mode is written only by PATCH /api/sessions/permission-modes, which
 * takes the browser-only checks, and this route does not — so accepting it
 * here would let any header-less loopback caller (an agent's own shell) set
 * `auto-with-generations` and switch every approval card off. The page never
 * sends it here (`useUpdateSettings`).
 */
export async function PATCH(request: Request) {
  const body: Partial<AppSettings> = await request.json();
  delete body.agentApprovalModes;
  updateSettings(body);
  const settings = getSettings();
  return NextResponse.json({ settings });
}
