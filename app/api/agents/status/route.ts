import { NextResponse } from "next/server";
import { buildAgentStatus, type AgentStatus } from "@/lib/agents/agent-status";
import { invalidateAgentCliMemo } from "@/lib/agents/cli/resolve";
import { refreshAgentCache } from "@/lib/agents/acp/agent-registry";
import { AGENT_SETUPS, isSetupAgentId } from "@/lib/agents/setup/registry";
import type { SetupAgentId } from "@/lib/agents/setup/commands";

export const dynamic = "force-dynamic";

const SETUP_AGENT_IDS: readonly SetupAgentId[] = AGENT_SETUPS.map((a) => a.id).filter(isSetupAgentId);

/**
 * GET /api/agents/status[?agent=<id>][&refresh=1] — see lib/agents/agent-status.ts.
 *
 * `?agent=` answers for one agent (the wizard polls that form, so a Claude poll
 * never spawns codex). `&refresh=1` is "Check again": it forgets the CLI memo and
 * the adapter detection cache, then asks each requested agent's registration
 * afresh, dropping only the registration's own answer memo — never starting a
 * second listing where one is already running. It does NOT drop the shared codex
 * listing itself (`__clearLibiRegistrationMemo`): clearing it out from under a
 * running listing orphaned that listing's slot and made the next read start a
 * second `codex mcp list`.
 *
 * Unlike the Providers tab's and Global setup card's Retry, Check again does NOT
 * assume nothing changed: the user may have just run their own `codex mcp add`
 * outside libi. A listing already running from before this request predates
 * whatever they just did, so it is not served as this request's answer — it is
 * let finish and exactly one more listing is asked, never two at once
 * (`readCodexMcpListing`'s `checkAgain`).
 */
export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const one = sp.get("agent");
  if (one !== null && !isSetupAgentId(one)) {
    return NextResponse.json({ error: "unknown agent" }, { status: 400 });
  }
  const ids: readonly SetupAgentId[] = one !== null ? [one] : SETUP_AGENT_IDS;
  const refresh = sp.get("refresh") === "1";
  if (refresh) {
    for (const id of ids) invalidateAgentCliMemo(id);
    refreshAgentCache();
  }
  const agents: Partial<Record<SetupAgentId, AgentStatus>> = {};
  for (const id of ids) agents[id] = await buildAgentStatus(id, { refresh });
  return NextResponse.json({ agents });
}
