import { NextResponse } from "next/server";
import { getSessionManager } from "@/lib/sessions/session-manager";
import { markPermissionResolvedInCache } from "@/lib/sessions/types";
import { serverLogger as logger } from "@/lib/logger";
import { browserOnlyRefusal } from "@/lib/security/request-guard";

/**
 * POST /api/sessions/[sessionId]/permission
 *
 * Resolves a pending ACP permission request. The user clicks an option in the
 * permission card; the chat client posts `{ pendingId, optionId }` here. We
 * resolve the held promise (so the agent can continue) and emit
 * `agent-permission-resolved` for any other clients watching this session.
 *
 * Takes the browser-only checks (`browserOnlyRefusal`): the card is answered
 * from libi's own chat, never by a header-less loopback client. The
 * `pendingId` rides the unauthenticated SSE stream, so without this an
 * agent's own shell could approve its own card with one curl. A local program
 * that deliberately forges the page's headers still passes — see the
 * LIMITATIONS in lib/approval/extensions.ts (limit 1).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const refused = browserOnlyRefusal(req);
  if (refused) {
    logger.warn({ tag: "session-manager", op: "permission_refused", reason: refused }, "approval card answer refused: not from libi's own page");
    return NextResponse.json({ error: "libi couldn't confirm this answer came from its own chat page. Use an up-to-date browser, or the desktop app.", code: "browser_only" }, { status: 403 });
  }
  const { sessionId } = await params;
  const sm = getSessionManager();
  const session = sm.getSession(sessionId);
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }

  let body: { pendingId?: string; optionId?: string };
  try {
    body = (await req.json()) as { pendingId?: string; optionId?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.pendingId || !body.optionId) {
    return NextResponse.json(
      { error: "pendingId and optionId required" },
      { status: 400 },
    );
  }

  const pending = session.pendingApprovals.get(body.pendingId);
  if (!pending) {
    return NextResponse.json(
      { error: "pending approval not found" },
      { status: 404 },
    );
  }

  // Validate the optionId exists in the offered set — prevents the agent from
  // receiving a fabricated optionId that would confuse its protocol layer.
  const option = pending.options.find((o) => o.optionId === body.optionId);
  if (!option) {
    return NextResponse.json(
      { error: "optionId not in offered options" },
      { status: 400 },
    );
  }

  pending.resolve({
    outcome: { outcome: "selected", optionId: body.optionId },
  });
  session.pendingApprovals.delete(body.pendingId);
  // The card is also in the session's history; close it there so a reload
  // shows it answered, not answerable.
  markPermissionResolvedInCache(session, body.pendingId, {
    kind: "selected",
    optionId: body.optionId,
  });

  // `emitForSession` fans out to per-session, pending, AND global listeners,
  // so the SSE bridge picks this up and forwards to the chat UI.
  sm.emitForSession(sessionId, {
    type: "agent-permission-resolved",
    pendingId: body.pendingId,
    outcome: { kind: "selected", optionId: body.optionId },
  });

  return NextResponse.json({ ok: true });
}
