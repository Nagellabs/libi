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
 *
 * `shellEnvLoaded` is false when the session's agent process was spawned before
 * the desktop app loaded the user's shell environment; the chat warns about it.
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
    // empty-state placeholder rather than a hard error. Nothing to warn about.
    return NextResponse.json({ messages: [], shellEnvLoaded: true });
  }

  try {
    const messages = await sm.activateSession(sessionId);
    // Read AFTER activation: a resumed session learns which agent process it
    // runs on (and so whether that process had the shell environment) only then.
    return NextResponse.json({ messages, shellEnvLoaded: entry.shellEnvLoaded !== false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message, messages: [], shellEnvLoaded: true }, { status: 500 });
  }
}
