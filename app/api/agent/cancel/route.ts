import { NextResponse } from "next/server";
import { getSessionManager } from "@/lib/sessions/session-manager";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { sessionId?: string };
  const sessionId = body.sessionId;
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }
  await getSessionManager().cancelTurn(sessionId);
  return NextResponse.json({ success: true });
}
