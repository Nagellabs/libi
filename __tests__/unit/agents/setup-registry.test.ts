import { describe, expect, it } from "vitest";
import { AGENT_SETUPS, getAgentSetup, listAgentSetups } from "@/lib/agents/setup/registry";

describe("agent setup registry", () => {
  it("knows the two ACP agents and not the terminal pseudo-provider", () => {
    expect(listAgentSetups().map((a) => a.id).sort()).toEqual(["claude-code", "codex"]);
    // Terminal is not an ACP agent; modelling it as one would give it a
    // sign-in flow it has no use for.
    expect(getAgentSetup("terminal")).toBeNull();
    expect(getAgentSetup("nope")).toBeNull();
  });

  it("declares an install for Claude Code and none for Codex", () => {
    expect(getAgentSetup("claude-code")!.install).not.toBeNull();
    // libi SHIPS the codex engine. Offering an install here is what told users
    // to install something they already had.
    expect(getAgentSetup("codex")!.install).toBeNull();
  });

  it("gives every agent a sign-in route — no agent is exempt", () => {
    for (const a of AGENT_SETUPS) {
      expect(a.signIn.displayCommand.length).toBeGreaterThan(0);
    }
  });

  it("uses exactly three manual steps everywhere, so the card is one shape", () => {
    for (const a of AGENT_SETUPS) {
      expect(a.signIn.manual).toHaveLength(3);
      if (a.install) expect(a.install.manual).toHaveLength(3);
    }
  });

  it("keeps the three beats aligned across agents", () => {
    const claude = getAgentSetup("claude-code")!.signIn.manual;
    const codex = getAgentSetup("codex")!.signIn.manual;
    // Beat 1 and beat 3 are IDENTICAL between agents — only the command and
    // the provider-specific middle sentence differ. If these drift, the two
    // cards have stopped being one design.
    expect(claude[0].text).toBe(codex[0].text);
    expect(claude[2].text).toBe(codex[2].text);
    expect(claude[1].text).not.toBe(codex[1].text);
  });

  it("puts the command in the command field, not inline in the prose", () => {
    for (const a of AGENT_SETUPS) {
      const steps = [...a.signIn.manual, ...(a.install?.manual ?? [])];
      for (const s of steps) {
        if (s.text.includes("{cmd}")) expect(s.command).toBeTruthy();
        if (s.command) expect(s.text).toContain("{cmd}");
      }
    }
  });

  it("keeps every manual step to one sentence", () => {
    for (const a of AGENT_SETUPS) {
      for (const s of [...a.signIn.manual, ...(a.install?.manual ?? [])]) {
        // "More clear and long, but not too long": one sentence, under 160
        // chars. Long enough to say what happens, short enough to be read.
        expect(s.text.length).toBeLessThanOrEqual(160);
      }
    }
  });

  it("never names a version — versions go stale in copy nobody re-reads", () => {
    for (const a of AGENT_SETUPS) {
      expect(JSON.stringify(a)).not.toMatch(/\d+\.\d+\.\d+/);
    }
  });
});

/**
 * Finding 7: adding an agent takes three entries in three files, and nothing
 * asserted they agree.
 *
 * The split is deliberate and stays: `lib/agents/setup/registry.ts` is pure
 * and imported by React components, so it must never reach the filesystem,
 * while the detection table and the sign-in resolvers must. What was missing
 * is the loop being closed — a registry entry with no detection entry is an
 * agent the app offers to set up and can never see, and one with no sign-in
 * resolver is a "Sign in" button that resolves to null.
 */
describe("the three agent registries agree", () => {
  it("gives every declared agent a detection-table entry", async () => {
    const { knownAgentIds } = await import("@/lib/agents/acp/agent-registry");
    const detected = new Set(knownAgentIds());
    for (const a of AGENT_SETUPS) {
      expect(detected, `${a.id} is declared but never detected`).toContain(a.id);
    }
  });

  it("gives every declared agent a sign-in resolver", async () => {
    const { signInResolverIds } = await import("@/lib/agents/acp/sign-in-remedy");
    const resolvers = new Set(signInResolverIds());
    for (const a of AGENT_SETUPS) {
      expect(resolvers, `${a.id} declares a sign-in with no resolver`).toContain(a.id);
    }
  });

  it("has no resolver or detection entry for an agent nobody declared", async () => {
    const { signInResolverIds } = await import("@/lib/agents/acp/sign-in-remedy");
    const declared = new Set(AGENT_SETUPS.map((a) => a.id));
    for (const id of signInResolverIds()) {
      expect(declared, `${id} has a sign-in resolver but no setup declaration`).toContain(id);
    }
  });
});
