import { NextResponse } from "next/server";
import { getSessionManager } from "@/lib/sessions/session-manager";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  await getSessionManager().deactivateSession(sessionId);
  return NextResponse.json({ success: true });
}
