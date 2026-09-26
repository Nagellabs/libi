import { NextResponse } from "next/server";
import { getAllApprovalModes, setApprovalMode } from "@/lib/approval/settings";
import { isApprovalMode } from "@/lib/approval/mode";
import { getSessionManager } from "@/lib/sessions/session-manager";
import { serverLogger as logger } from "@/lib/logger";
import { browserOnlyRefusal } from "@/lib/security/request-guard";

/**
 * GET /api/sessions/permission-modes
 *
 * Returns the saved approval-mode map keyed by agentId. Agents not in the map
 * fall back to `DEFAULT_APPROVAL_MODE` ("auto") on read; the UI uses this list
 * purely to render which agent has which saved value.
 */
export async function GET(): Promise<Response> {
  return NextResponse.json({ modes: getAllApprovalModes() });
}

/**
 * PATCH /api/sessions/permission-modes
 *
 * Updates the saved approval mode for a single agent. Persists to the settings
 * DB and broadcasts the new mode to every active session belonging to that
 * agent via ACP `session/set_mode` (best-effort; failures are logged inside
 * SessionManager and never propagated here).
 *
 * Takes the browser-only checks (`browserOnlyRefusal`): the mode decides
 * whether an approval card appears at all, so an agent's shell must not be
 * able to switch cards off with a header-less curl instead of answering one.
 * Its one caller is the chat's mode picker (`useUpdateApprovalMode`).
 */
export async function PATCH(req: Request): Promise<Response> {
  const refused = browserOnlyRefusal(req);
  if (refused) {
    logger.warn({ tag: "session-manager", op: "permission_modes_refused", reason: refused }, "approval mode change refused: not from libi's own page");
    return NextResponse.json({ error: "The approval mode is changed only in libi's chat.", code: "browser_only" }, { status: 403 });
  }
  let body: { agentId?: string; mode?: string };
  try {
    body = (await req.json()) as { agentId?: string; mode?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.agentId || !isApprovalMode(body.mode)) {
    return NextResponse.json(
      { error: "agentId and valid mode required" },
      { status: 400 },
    );
  }

  setApprovalMode(body.agentId, body.mode);
  await getSessionManager().applyApprovalModeToActiveSessions(body.agentId);
  return NextResponse.json({ ok: true });
}
