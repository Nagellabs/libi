import { NextResponse } from "next/server";
import { getSessionManager } from "@/lib/sessions/session-manager";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const sm = getSessionManager();

  try {
    const messages = await sm.activateSession(sessionId);
    return NextResponse.json({ success: true, sessionId, messages });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
