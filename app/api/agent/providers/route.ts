import { NextResponse } from "next/server";
import { getProviderInfos } from "@/lib/agents/provider-registry";
import { getProcessManager } from "@/lib/agents/process-manager";

// Detection is kept current by its owners — the Agents page's status route
// and agent installs call `refreshAgentCache()` — so this is a plain read.
export async function GET() {
  const pm = getProcessManager();
  const infos: Array<Record<string, unknown>> = (await getProviderInfos()).map((info) => ({
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
