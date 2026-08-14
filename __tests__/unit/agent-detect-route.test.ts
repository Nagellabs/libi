import { it, expect, vi } from "vitest";

vi.mock("@/lib/agents/acp/agent-registry", () => ({
  detectInstalledAgents: () => [
    { id: "claude-code", name: "Claude Code", detectCommand: "claude", installed: true, envHints: ["ANTHROPIC_API_KEY"] },
    { id: "codex", name: "Codex CLI", detectCommand: "codex", installed: false, envHints: ["OPENAI_API_KEY"] },
  ],
}));

it("returns detection results", async () => {
  const { GET } = await import("@/app/api/agent/detect/route");
  const json = await (await GET()).json();
  expect(json.agents).toEqual([
    { id: "claude-code", name: "Claude Code", installed: true, detectCommand: "claude" },
    { id: "codex", name: "Codex CLI", installed: false, detectCommand: "codex" },
  ]);
});
