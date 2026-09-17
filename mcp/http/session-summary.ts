import type { AgentSurface } from "@/lib/mcp/agent-surface";

export interface SessionsBy {
  inApp: { claude: number; codex: number };
  cli: { claude: number; codex: number };
}

/** Pure fold for `/healthz`: counts live sessions by surface and dialect. */
export function summarizeSessions(entries: Iterable<{ surface: AgentSurface; dialect: "claude" | "codex" }>): SessionsBy {
  const out: SessionsBy = { inApp: { claude: 0, codex: 0 }, cli: { claude: 0, codex: 0 } };
  for (const e of entries) out[e.surface === "in-app" ? "inApp" : "cli"][e.dialect]++;
  return out;
}
