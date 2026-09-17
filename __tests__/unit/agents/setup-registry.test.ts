import { describe, expect, it } from "vitest";
import {
  AGENT_SETUPS,
  agentSetupHref,
  getAgentSetup,
  isSetupAgentId,
  listAgentSetups,
} from "@/lib/agents/setup/registry";

describe("agent setup registry", () => {
  it("knows the two ACP agents and not the terminal pseudo-provider", () => {
    expect(listAgentSetups().map((a) => a.id).sort()).toEqual(["claude-code", "codex"]);
    // Terminal is not an ACP agent; modelling it as one would give it a
    // sign-in flow it has no use for.
    expect(getAgentSetup("terminal")).toBeNull();
    expect(getAgentSetup("nope")).toBeNull();
  });

  it("declares a download for both agents — each downloads on selection", () => {
    for (const a of AGENT_SETUPS) {
      expect(a.install, a.id).toBe(true);
    }
  });

  it("declares data only — no install command, no size or wording, no manual steps; download copy lives in adapter-copy.ts, commands in commands.ts", () => {
    for (const a of AGENT_SETUPS) {
      expect(JSON.stringify(a), a.id).not.toMatch(/\bMB\b|sizeLabel|command"/);
      expect(a.signIn, a.id).not.toHaveProperty("manual");
    }
  });

  it("gives every agent a sign-in route — no agent is exempt", () => {
    for (const a of AGENT_SETUPS) {
      expect(a.signIn.displayCommand.length).toBeGreaterThan(0);
    }
  });

  it("declares where each agent rejects auth — readiness depends on it", () => {
    // Claude Code's session/new succeeds signed out; only its prompt is refused.
    expect(getAgentSetup("claude-code")!.signIn.rejectedAt).toBe("prompt");
    expect(getAgentSetup("codex")!.signIn.rejectedAt).toBe("session-new");
  });

  it("never names a version — versions go stale in copy nobody re-reads", () => {
    for (const a of AGENT_SETUPS) {
      expect(JSON.stringify(a)).not.toMatch(/\d+\.\d+\.\d+/);
    }
  });

  it("never tells anyone to restart libi, and never mentions an engine", () => {
    for (const a of AGENT_SETUPS) {
      expect(JSON.stringify(a)).not.toMatch(/restart libi|engine/i);
    }
  });

  it("the guard rejects an id with no declaration, terminal included", () => {
    expect(isSetupAgentId("claude-code")).toBe(true);
    expect(isSetupAgentId("codex")).toBe(true);
    expect(isSetupAgentId("terminal")).toBe(false);
    expect(isSetupAgentId("some-future-agent")).toBe(false);
  });
});

describe("agentSetupHref — where a not-ready surface sends the user", () => {
  it("opens the Agents tab on a declared agent's setup", () => {
    expect(agentSetupHref("claude-code")).toBe("/agents?tab=agents&agent=claude-code");
    expect(agentSetupHref("codex")).toBe("/agents?tab=agents&agent=codex");
  });

  it("opens the Agents tab itself for no agent, the terminal, or an undeclared id", () => {
    expect(agentSetupHref(null)).toBe("/agents?tab=agents");
    expect(agentSetupHref(undefined)).toBe("/agents?tab=agents");
    expect(agentSetupHref("terminal")).toBe("/agents?tab=agents");
    expect(agentSetupHref("some-future-agent")).toBe("/agents?tab=agents");
  });
});

/**
 * Adding an agent takes an entry in two places, and nothing else asserts they
 * agree.
 *
 * The split is deliberate and stays: `lib/agents/setup/registry.ts` is pure
 * and imported by React components, so it must never reach the filesystem,
 * while the detection table must. A registry entry with no detection entry is
 * an agent the app offers to set up and can never see.
 */
describe("the two agent registries agree", () => {
  it("gives every declared agent a detection-table entry", async () => {
    const { knownAgentIds } = await import("@/lib/agents/acp/agent-registry");
    const detected = new Set(knownAgentIds());
    for (const a of AGENT_SETUPS) {
      expect(detected, `${a.id} is declared but never detected`).toContain(a.id);
    }
  });
});
