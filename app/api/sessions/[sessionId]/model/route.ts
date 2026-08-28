import { NextResponse } from "next/server";
import { getSessionManager } from "@/lib/sessions/session-manager";

/**
 * GET /api/sessions/[sessionId]/model
 *
 * Returns the model state for the session. `{ supported: false, pending: true }`
 * means "not known yet" (configOptions not captured — activation replay in
 * flight, or the session not yet registered after a restart); the UI shows a
 * skeleton and waits for the agent-config-options SSE event.
 * `{ supported: false, pending: false }` means the agent genuinely advertises
 * no model select — the UI hides the picker.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const { sessionId } = await params;
  const snapshot = getSessionManager().getSessionModelSnapshot(sessionId);
  if (!snapshot) return NextResponse.json({ supported: false, pending: true });
  return NextResponse.json(snapshot);
}

/**
 * PATCH /api/sessions/[sessionId]/model  { modelId }
 *
 * Switches the model for this session via ACP set_config_option AND persists the
 * choice per-agent so future sessions inherit it — ACP adapters don't persist a
 * model switch themselves, so libi remembers it (see SessionManager.setSessionModel
 * → setAgentModelId + pushModelToSession).
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const { sessionId } = await params;
  let body: { modelId?: string };
  try {
    body = (await req.json()) as { modelId?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.modelId) {
    return NextResponse.json({ error: "modelId required" }, { status: 400 });
  }
  try {
    const state = await getSessionManager().setSessionModel(sessionId, body.modelId);
    return NextResponse.json({ supported: true, ...(state ?? {}) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to set model";
    const status = message.includes("not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
