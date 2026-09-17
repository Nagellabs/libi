import { describe, it, expect } from "vitest";
import type { ProviderScriptAction, SetupAgentId } from "@/lib/agents/setup/commands";
import { findProvider, type ProviderDef } from "@/lib/providers/catalog";
import type { ChipState } from "@/lib/providers/chip-state";
import { providerSetupSteps } from "@/lib/providers/setup-steps";

const higgsfield = findProvider("higgsfield");

/** `add` and `sign-in` statuses, in order, or null for no stepper. */
function statuses(
  agentId: SetupAgentId,
  state: ChipState,
  liveAction: ProviderScriptAction | null = null,
  def: ProviderDef = higgsfield,
) {
  const result = providerSetupSteps({ def, agentId, state, liveAction });
  return result && { steps: result.steps.map((s) => `${s.id}:${s.status}`), combined: result.combined };
}

describe("providerSetupSteps — single-step providers keep their single action", () => {
  const states: ChipState[] = ["not-added", "connected", "needs-key", "disabled", "unknown", "agent-not-ready"];
  for (const id of ["fal", "elevenlabs"] as const) {
    for (const agentId of ["claude-code", "codex"] as const) {
      it(`${id} on ${agentId} has no steps in any state`, () => {
        for (const state of states) {
          expect(providerSetupSteps({ def: findProvider(id), agentId, state, liveAction: "provider-add" }), state).toBeNull();
        }
      });
    }
  }

  it("a provider with no published commands has no steps", () => {
    expect(statuses("claude-code", "not-added", null, { ...higgsfield, commands: undefined })).toBeNull();
  });
});

describe("providerSetupSteps — Claude Code × Higgsfield: add, then sign in", () => {
  it.each([
    ["not-added", ["add:current", "sign-in:locked"]],
    ["sign-in-unknown", ["add:done", "sign-in:current"]],
    ["connected", ["add:done", "sign-in:done"]],
  ] as const)("%s", (state, steps) => {
    expect(statuses("claude-code", state)).toEqual({ steps, combined: null });
  });

  it.each(["unknown", "agent-not-ready", "needs-key"] as const)("%s claims nothing, so there are no steps", (state) => {
    expect(statuses("claude-code", state)).toBeNull();
  });

  it("an entry whose scope couldn't be read offers only Retry, so there are no steps", () => {
    expect(providerSetupSteps({ def: higgsfield, agentId: "claude-code", state: "sign-in-unknown", scopeUnreadable: true })).toBeNull();
  });

  it("a live add runs the add only; the sign-in stays locked behind it", () => {
    expect(statuses("claude-code", "not-added", "provider-add")).toEqual({ steps: ["add:running", "sign-in:locked"], combined: null });
  });

  it("once detection shows the add, the sign-in is current even while the add's terminal is still open", () => {
    expect(statuses("claude-code", "sign-in-unknown", "provider-add")).toEqual({ steps: ["add:done", "sign-in:current"], combined: null });
  });

  it("a live sign-in runs the sign-in step", () => {
    expect(statuses("claude-code", "sign-in-unknown", "provider-sign-in")).toEqual({ steps: ["add:done", "sign-in:running"], combined: null });
  });

  it("a live remove runs no step", () => {
    expect(statuses("claude-code", "sign-in-unknown", "provider-remove")).toEqual({ steps: ["add:done", "sign-in:current"], combined: null });
  });
});

describe("providerSetupSteps — Codex × Higgsfield: one add that also signs in", () => {
  it("not added: both steps current, covered by one action", () => {
    expect(statuses("codex", "not-added")).toEqual({ steps: ["add:current", "sign-in:current"], combined: ["add", "sign-in"] });
  });

  it.each([
    ["needs-sign-in", ["add:done", "sign-in:current"]],
    ["sign-in-unknown", ["add:done", "sign-in:current"]],
    ["connected", ["add:done", "sign-in:done"]],
  ] as const)("%s reads like Claude Code's: each step left has its own action", (state, steps) => {
    expect(statuses("codex", state)).toEqual({ steps, combined: null });
  });

  it.each(["unknown", "agent-not-ready"] as const)("%s claims nothing, so there are no steps", (state) => {
    expect(statuses("codex", state)).toBeNull();
  });

  it("a live add runs both steps", () => {
    expect(statuses("codex", "not-added", "provider-add")).toEqual({ steps: ["add:running", "sign-in:running"], combined: ["add", "sign-in"] });
  });

  it("a live add whose entry is written but not signed in yet is still running the sign-in", () => {
    expect(statuses("codex", "needs-sign-in", "provider-add")).toEqual({ steps: ["add:done", "sign-in:running"], combined: null });
  });

  it("a live sign-in runs the sign-in step", () => {
    expect(statuses("codex", "needs-sign-in", "provider-sign-in")).toEqual({ steps: ["add:done", "sign-in:running"], combined: null });
  });

  it("an entry switched off in Codex's config blocks the sign-in instead of making it current, and it is not waiting on the terminal", () => {
    expect(statuses("codex", "disabled")).toEqual({ steps: ["add:done", "sign-in:blocked"], combined: null });
    for (const action of ["provider-add", "provider-sign-in"] as const) {
      expect(statuses("codex", "disabled", action)).toEqual({ steps: ["add:done", "sign-in:blocked"], combined: null });
    }
  });

  it("a signed-in entry is done whatever the terminal is running", () => {
    for (const action of ["provider-add", "provider-sign-in", "provider-remove"] as const) {
      expect(statuses("codex", "connected", action)).toEqual({ steps: ["add:done", "sign-in:done"], combined: null });
    }
  });
});

describe("providerSetupSteps — which add signs in is catalog data", () => {
  it("Higgsfield names Codex, and only Codex, as the agent whose add signs in", () => {
    expect(higgsfield.addSignsIn).toEqual(["codex"]);
  });

  it("an entry naming Claude Code makes Claude Code's add the combined action, and Codex's separate", () => {
    const def = { ...higgsfield, addSignsIn: ["claude"] as const };
    expect(statuses("claude-code", "not-added", null, def)).toEqual({ steps: ["add:current", "sign-in:current"], combined: ["add", "sign-in"] });
    expect(statuses("codex", "not-added", null, def)).toEqual({ steps: ["add:current", "sign-in:locked"], combined: null });
  });

  it("an entry naming no agent gives both agents an add, then a separate sign-in", () => {
    const def = { ...higgsfield, addSignsIn: undefined };
    for (const agentId of ["claude-code", "codex"] as const) {
      expect(statuses(agentId, "not-added", null, def)).toEqual({ steps: ["add:current", "sign-in:locked"], combined: null });
    }
  });
});
