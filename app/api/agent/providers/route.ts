import { NextResponse } from "next/server";
import { refreshAgentCache } from "@/lib/agents/acp/agent-registry";
import { getProviderInfos } from "@/lib/agents/provider-registry";
import { getProcessManager } from "@/lib/agents/process-manager";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  if (searchParams.get("refresh") === "true") {
    refreshAgentCache();
  }
  const pm = getProcessManager();
  const infos: Array<Record<string, unknown>> = getProviderInfos().map((info) => ({
    ...info,
    capabilities: pm.getCapabilitiesForAgent(info.id),
  }));
  // The Terminal surface is a pseudo-provider: always available (no CLI
  // detection — the preset dropdown covers possibly-missing CLIs) and
  // never warmed through SessionManager/ACP.
  infos.push({
    id: "terminal",
    name: "Terminal",
    type: "terminal",
    available: true,
    requiresApiKey: false,
    apiKeyConfigured: true,
    capabilities: { canListSessions: true },
  });
  return NextResponse.json(infos);
}
