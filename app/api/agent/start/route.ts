import { NextResponse } from "next/server";
import { getSessionManager } from "@/lib/sessions/session-manager";
import { updateSettings } from "@/lib/db/settings";
import { getAgentConfig } from "@/lib/agents/acp/agent-registry";
import { setTerminalSurfaceActive } from "@/lib/terminal/active-surface";
import { serverLogger as logger } from "@/lib/logger";
import {
  isAuthRequiredError,
  type AgentReadiness,
} from "@/lib/agents/agent-readiness";

/**
 * How long to wait on the new agent's standby session before answering.
 *
 * The standby is the first (and, for codex, the ONLY — it advertises
 * `canListSessions:false`) `session/new` of a switch, so it is where a
 * `needs-auth` becomes knowable. Waiting a few seconds usually lets the
 * response carry the real answer; exceeding the budget is not a failure, it
 * just means the transition arrives moments later as an `agent-readiness` SSE
 * event instead.
 */
const STANDBY_WAIT_MS = 4000;

export async function POST(request: Request) {
  const { providerId } = await request.json();

  if (!providerId) {
    return NextResponse.json({ error: "providerId required" }, { status: 400 });
  }

  // The Terminal surface never warms an ACP process. Persist the
  // preference and flip the surface flag — ACP processes AND live
  // terminals are both left untouched, so switching surfaces is a pure
  // view change.
  if (providerId === "terminal") {
    updateSettings({ preferredAgent: "terminal" });
    setTerminalSurfaceActive(true);
    // The Terminal warms no ACP process, so there is no handshake to learn
    // anything from — `unknown` is the honest answer, not `ready`.
    const readiness: AgentReadiness = { state: "unknown" };
    return NextResponse.json({ success: true, providerId, readiness });
  }

  const config = getAgentConfig(providerId);
  if (!config?.installed) {
    const readiness: AgentReadiness = {
      state: "not-installed",
      reason:
        config?.unavailableReason?.message ??
        `Agent ${providerId} is not available`,
    };
    return NextResponse.json(
      {
        success: false,
        providerId,
        readiness,
        error: `Agent ${providerId} is not available`,
      },
      { status: 400 },
    );
  }

  const sm = getSessionManager();
  try {
    updateSettings({ preferredAgent: providerId });
    setTerminalSurfaceActive(false);

    // Was fire-and-forget with a `console.error` — the route returned
    // `{success:true}` before `switchAgent` had done anything at all, so a
    // switch that failed outright was indistinguishable from one that worked.
    // Awaiting it is the whole point: the caller now learns the outcome.
    const readiness = await sm.switchAgent(providerId, {
      awaitStandbyMs: STANDBY_WAIT_MS,
    });

    return NextResponse.json({ success: true, providerId, readiness });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // "Not signed in" is an EXPECTED outcome, not a transport failure. The
    // switch itself worked — the agent is selected and warm; it just can't open
    // sessions yet, which `readiness` states precisely and the sidebar renders
    // with a sign-in action. Returning 5xx here made `selectAgent` (which
    // rethrows every non-OK response) surface a red Next error overlay reading
    // "Authentication required" — swapping a silent dead end for a crash. The
    // real fix is upstream in `loadInitialSessions`; this branch stays so no
    // future auth-throwing call site can resurrect the overlay.
    if (isAuthRequiredError(err)) {
      return NextResponse.json({
        success: true,
        providerId,
        readiness: sm.getReadiness(providerId),
      });
    }

    logger.error(
      { tag: "session-manager", op: "agent_switch_failed", agentId: providerId, err },
      `Agent switch to ${providerId} failed`,
    );
    return NextResponse.json(
      {
        success: false,
        providerId,
        readiness: sm.getReadiness(providerId),
        error: message,
      },
      { status: 500 },
    );
  }
}
