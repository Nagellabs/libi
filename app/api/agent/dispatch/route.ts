import { NextResponse } from "next/server";
import { dispatchToAgent } from "@/lib/agents/dispatch";
import { NoAgentConfiguredError } from "@/lib/agents/errors";

/**
 * POST /api/agent/dispatch — hand an arbitrary prompt to the libi agent.
 * The canonical endpoint for sending a NON-internal task to the agent from
 * the UI. Returns 409 { error: "no_agent" } when no agent is configured
 * (bring-your-own-CLI) so the client can show a friendly copy-to-clipboard
 * fallback instead of an error.
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
    throw err;
  }
}
