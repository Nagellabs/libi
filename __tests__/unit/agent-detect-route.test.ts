import { it, expect, vi } from "vitest";

vi.mock("@/lib/agents/acp/agent-registry", () => ({
  detectInstalledAgents: () => [
    { id: "claude-code", name: "Claude Code", detectCommand: "claude", installed: true, envHints: ["ANTHROPIC_API_KEY"] },
    { id: "codex", name: "Codex CLI", detectCommand: "codex", installed: false, envHints: ["OPENAI_API_KEY"] },
  ],
}));

// The real resolver walks npm trees for an engine binary. What this route owes
// its caller is that it ASKS per agent and reports whatever comes back —
// including `null` for an agent it cannot resolve a command for, which the
// connect screen reads as "fall back to the readable short form".
vi.mock("@/lib/agents/acp/sign-in-remedy", () => ({
  resolveSignInRemedy: (agentId: string) =>
    agentId === "claude-code"
      ? { label: "Sign in to Claude Code", command: "'/opt/libi/bin/claude'", detail: "" }
      : null,
}));

it("returns detection results, each carrying the sign-in command resolved on this machine", async () => {
  const { GET } = await import("@/app/api/agent/detect/route");
  const json = await (await GET()).json();
  expect(json.agents).toEqual([
    {
      id: "claude-code",
      name: "Claude Code",
      installed: true,
      detectCommand: "claude",
      signInRemedy: {
        label: "Sign in to Claude Code",
        command: "'/opt/libi/bin/claude'",
        detail: "",
      },
    },
    {
      id: "codex",
      name: "Codex CLI",
      installed: false,
      detectCommand: "codex",
      signInRemedy: null,
    },
  ]);
});

it("serves the remedy regardless of whether the agent is installed or signed in", async () => {
  const { GET } = await import("@/app/api/agent/detect/route");
  const json = await (await GET()).json();
  const claude = json.agents.find((a: { id: string }) => a.id === "claude-code");
  // The whole point: this is available on FIRST PAINT, before any agent has
  // been selected and therefore before any readiness exists. It asserts
  // nothing about whether signing in is actually needed.
  // The whole remedy, because the connect screen RUNS it rather than
  // printing it — Claude Code cannot be probed for auth, so the button must
  // open a terminal instead of connecting.
  expect(claude.signInRemedy.command).toBe("'/opt/libi/bin/claude'");
  expect(claude.installed).toBe(true);
});
