import { NextResponse } from "next/server";
import { setSignInConfirmed } from "@/lib/agents/sign-in-confirmation";
import { isSetupAgentId } from "@/lib/agents/setup/registry";
import { getSessionManager } from "@/lib/sessions/session-manager";

/** POST — the wizard's "I've signed in" / "I'm already signed in". */
export async function POST(_request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  if (!isSetupAgentId(agentId)) return NextResponse.json({ error: "unknown agent" }, { status: 400 });
  const at = setSignInConfirmed(agentId, undefined);
  // The user's word supersedes an older observed rejection. Readiness goes back
  // to unknown, never ready: the user's word is not an observation of the agent
  // working. The next clean session/new (the standby) or returned prompt records
  // ready, and a prompt rejection records needs-auth again.
  getSessionManager().forgetObservedAuthFailure(agentId);
  return NextResponse.json({ confirmedAt: at.toISOString() });
}
