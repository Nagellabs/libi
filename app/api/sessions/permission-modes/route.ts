import { NextResponse } from "next/server";
import { getAllApprovalModes, setApprovalMode } from "@/lib/approval/settings";
import { isApprovalMode } from "@/lib/approval/mode";
import { getSessionManager } from "@/lib/sessions/session-manager";

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
 */
export async function PATCH(req: Request): Promise<Response> {
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
