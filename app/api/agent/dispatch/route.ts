import { NextResponse } from "next/server";
import { dispatchToAgent } from "@/lib/agents/dispatch";
import {
  ApprovalModeHeldError,
  DispatchChatTakenError,
  NoAgentConfiguredError,
} from "@/lib/agents/errors";

/**
 * POST /api/agent/dispatch — hand an arbitrary prompt to the libi agent.
 * The canonical endpoint for sending a NON-internal task to the agent from
 * the UI. Returns 409 { error: "no_agent" } when no agent is configured
 * (bring-your-own-CLI) so the client can show a friendly copy-to-clipboard
 * fallback instead of an error. Returns 503 { error, approvalModeNotApplied, sessionId } when the
 * new chat's approval mode is held ("Ask each time" / "Auto" not in force): the prompt was NOT sent,
 * and the client says why instead of opening an empty chat.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { prompt?: string };
  const prompt = (body.prompt ?? "").trim();
  if (!prompt) {
    return NextResponse.json({ error: "prompt required" }, { status: 400 });
  }
  try {
    const { sessionId } = await dispatchToAgent({ prompt });
    return NextResponse.json({ success: true, sessionId });
  } catch (err) {
    if (err instanceof NoAgentConfiguredError) {
      // Not a server error — the user is in bring-your-own-CLI mode.
      return NextResponse.json({ error: "no_agent" }, { status: 409 });
    }
    if (err instanceof ApprovalModeHeldError) {
      return NextResponse.json(
        { error: err.gate.error, approvalModeNotApplied: err.gate.mode, sessionId: err.sessionId },
        { status: 503 },
      );
    }
    if (err instanceof DispatchChatTakenError) {
      return NextResponse.json({ error: err.message, sessionId: err.sessionId }, { status: 503 });
    }
    throw err;
  }
}
