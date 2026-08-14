import { NextResponse } from "next/server";
import { getSessionManager } from "@/lib/sessions/session-manager";

/**
 * POST /api/sessions/[sessionId]/permission
 *
 * Resolves a pending ACP permission request. The user clicks an option in the
 * permission card; the chat client posts `{ pendingId, optionId }` here. We
 * resolve the held promise (so the agent can continue) and emit
 * `agent-permission-resolved` for any other clients watching this session.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
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

  // `emitForSession` fans out to per-session, pending, AND global listeners,
  // so the SSE bridge picks this up and forwards to the chat UI.
  sm.emitForSession(sessionId, {
    type: "agent-permission-resolved",
    pendingId: body.pendingId,
    outcome: { kind: "selected", optionId: body.optionId },
  });

  return NextResponse.json({ ok: true });
}
