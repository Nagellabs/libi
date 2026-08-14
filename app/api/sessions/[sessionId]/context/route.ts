import { NextResponse } from "next/server";
import { getSessionManager } from "@/lib/sessions/session-manager";

/**
 * GET /api/sessions/[sessionId]/context
 *
 * Snapshot of the session's latest usage_update state + advertised slash
 * commands (see lib/sessions/usage.ts). In-memory only — `usage` is null
 * until the session's first usage_update after a server start.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const { sessionId } = await params;
  const ctx = getSessionManager().getSessionContext(sessionId);
  if (!ctx) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  return NextResponse.json(ctx);
}
