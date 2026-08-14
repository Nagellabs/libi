import { NextResponse } from "next/server";
import { getSessionManager } from "@/lib/sessions/session-manager";

/**
 * GET /api/agent/messages?sessionId=…
 *
 * Returns the full message cache for a session. If the session is known but
 * not yet active, this blocks until the ACP `loadSession` replay completes —
 * `activateSession()` dedupes against any in-flight activation (e.g. a
 * concurrent POST /activate from the sidebar), so callers always observe the
 * fully replayed cache rather than a partial/empty one.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }

  const sm = getSessionManager();
  const entry = sm.getSession(sessionId);
  if (!entry) {
    // Unknown session — treat as empty so the UI can gracefully show the
    // empty-state placeholder rather than a hard error.
    return NextResponse.json({ messages: [] });
  }

  try {
    const messages = await sm.activateSession(sessionId);
    return NextResponse.json({ messages });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message, messages: [] }, { status: 500 });
  }
}
