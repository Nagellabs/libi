import { NextResponse } from "next/server";
import { detectInstalledAgents } from "@/lib/agents/acp/agent-registry";

export async function GET(): Promise<Response> {
  const agents = detectInstalledAgents().map((a) => ({
    id: a.id,
    name: a.name,
    installed: a.installed,
    detectCommand: a.detectCommand,
  }));
  return NextResponse.json({ agents });
}
