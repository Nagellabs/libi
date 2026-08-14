import { NextResponse } from "next/server";
import { getSessionManager } from "@/lib/sessions/session-manager";
import { isTerminalSurfaceActive } from "@/lib/terminal/active-surface";

/** GET /api/sessions — list all sessions */
export async function GET() {
  const sm = getSessionManager();
  const sessions = sm.getAllSessions().map((s) => ({
    sessionId: s.sessionId,
    agentId: s.agentId,
    title: s.title,
    updatedAt: s.updatedAt,
    active: s.active,
  }));

  // The Terminal surface overrides what the selector shows as active;
  // SessionManager keeps tracking the last warmed ACP agent underneath
  // so switching back is instant.
  const activeAgentId = isTerminalSurfaceActive() ? "terminal" : sm.activeAgentId;

  return NextResponse.json({
    sessions,
    activeAgentId,
    standbyReady: sm.isStandbyReady(),
    // Readiness for whichever agent we just named active. Without this a page
    // load is blind: a `needs-auth` learned before the client connected its
    // SSE stream would never be re-broadcast, and the UI would render an
    // agent that cannot chat as if it were fine. `terminal` has no ACP
    // handshake, so it reads back `unknown`.
    readiness: sm.getReadiness(activeAgentId),
  });
}

/** POST /api/sessions — create a new session */
export async function POST() {
  const sm = getSessionManager();
  if (!sm.activeAgentId) {
    return NextResponse.json(
      { error: "No active agent. Select an agent first." },
      { status: 400 },
    );
  }

  try {
    const sessionId = await sm.createSession();
    return NextResponse.json({ sessionId }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
