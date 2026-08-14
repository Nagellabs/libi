import { NextResponse } from "next/server";
import { getSessionManager } from "@/lib/sessions/session-manager";

export async function POST(request: Request) {
  const { sessionId } = await request.json();

  if (sessionId) {
    await getSessionManager().deactivateSession(sessionId);
  }

  return NextResponse.json({ success: true });
}
