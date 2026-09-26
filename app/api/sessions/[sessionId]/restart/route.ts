import { NextResponse } from "next/server";
import { getSessionManager } from "@/lib/sessions/session-manager";
import { isSessionRestartError, restartFailureStatus } from "@/lib/sessions/restart-error";
import { serverLogger as logger } from "@/lib/logger";
import { browserOnlyRefusal } from "@/lib/security/request-guard";

/**
 * POST /api/sessions/:sessionId/restart — "Restart session" in the chat's right-click menu.
 *
 * Closes the chat's ACP session and loads it again, keeping the conversation, so MCP servers added
 * to the agent's config since the chat was created are in it afterwards, and a chat stuck on a
 * dead or hung adapter comes back (`SessionManager.restartSession`, which bounds every wait).
 * Answers once the chat has loaded again, or with the reason in plain words (`error`) and a
 * `code` when it did not.
 *
 * Takes the browser-only checks (`browserOnlyRefusal`), like PATCH /api/sessions/permission-modes:
 * a restart cancels the chat's running turn, so the agent's own shell must not be able to restart
 * its chat with a header-less curl. Its one caller is the session menu (`useRestartSession`).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const refused = browserOnlyRefusal(req);
  if (refused) {
    logger.warn(
      { tag: "session-manager", op: "session_restart_refused", reason: refused },
      "session restart refused: not from libi's own page",
    );
    return NextResponse.json(
      { error: "A chat is restarted only from libi's own window.", code: "browser_only" },
      { status: 403 },
    );
  }
  const { sessionId } = await params;
  try {
    const { processRestarted } = await getSessionManager().restartSession(sessionId);
    return NextResponse.json({ ok: true, processRestarted });
  } catch (err) {
    if (isSessionRestartError(err)) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: restartFailureStatus(err.code) });
    }
    logger.error(
      { tag: "session-manager", op: "session_restart_failed", sessionId, err },
      "session restart threw unexpectedly",
    );
    return NextResponse.json({ error: "libi couldn't restart this chat. Try again, or reload the page." }, { status: 500 });
  }
}

/**
 * GET /api/sessions/:sessionId/restart — `{ restarting }`: whether a restart of the chat is under
 * way. A window whose SSE connection came back while it watched another window's restart asks, to
 * know whether that restart's `done` is still to come or was sent while it was disconnected
 * (`useAgentChat`, `sse-reconnected`). Read-only, one boolean.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const { sessionId } = await params;
  return NextResponse.json({ restarting: getSessionManager().isRestarting(sessionId) });
}
