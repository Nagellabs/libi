import { describe, it, expect } from "vitest";
import type { ProviderScriptAction, SetupAgentId } from "@/lib/agents/setup/commands";
import { findProvider, type ProviderDef } from "@/lib/providers/catalog";
import type { ChipState } from "@/lib/providers/chip-state";
import { providerSetupSteps } from "@/lib/providers/setup-steps";

const higgsfield = findProvider("higgsfield");
/** Higgsfield as if only Codex's add signed in: an agent whose add is followed by a sign-in of its own. */
const separate: ProviderDef = { ...higgsfield, addSignsIn: ["codex"] };

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
  const states: ChipState[] = ["not-added", "connected", "needs-key", "disabled", "cant-start", "unknown", "agent-not-ready"];
  for (const id of ["fal"] as const) {
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

describe("providerSetupSteps — an agent whose add does not sign in: add, then sign in", () => {
  it.each([
    ["not-added", ["add:current", "sign-in:locked"]],
    ["sign-in-unknown", ["add:done", "sign-in:current"]],
    ["connected", ["add:done", "sign-in:done"]],
  ] as const)("%s", (state, steps) => {
    expect(statuses("claude-code", state, null, separate)).toEqual({ steps, combined: null });
  });

  it.each(["unknown", "agent-not-ready", "needs-key"] as const)("%s claims nothing, so there are no steps", (state) => {
    expect(statuses("claude-code", state, null, separate)).toBeNull();
  });

  // A local entry whose launcher is missing is fixed by removing it or adding it again, not by signing in:
  // the chip shows those two actions instead of a stepper.
  it.each(["claude-code", "codex"] as const)("cant-start on %s shows no steps", (agentId) => {
    expect(statuses(agentId, "cant-start")).toBeNull();
    expect(statuses(agentId, "cant-start", "provider-replace")).toBeNull();
    expect(statuses(agentId, "cant-start", null, separate)).toBeNull();
  });

  it("an entry whose scope couldn't be read offers only Retry, so there are no steps", () => {
    expect(providerSetupSteps({ def: separate, agentId: "claude-code", state: "sign-in-unknown", scopeUnreadable: true })).toBeNull();
  });

  it("a live add runs the add only; the sign-in stays locked behind it", () => {
    expect(statuses("claude-code", "not-added", "provider-add", separate)).toEqual({ steps: ["add:running", "sign-in:locked"], combined: null });
  });

  it("once detection shows the add, the sign-in is current even while the add's terminal is still open", () => {
    expect(statuses("claude-code", "sign-in-unknown", "provider-add", separate)).toEqual({ steps: ["add:done", "sign-in:current"], combined: null });
  });

  it("a live sign-in runs the sign-in step", () => {
    expect(statuses("claude-code", "sign-in-unknown", "provider-sign-in", separate)).toEqual({ steps: ["add:done", "sign-in:running"], combined: null });
  });

  it("a live remove runs no step", () => {
    expect(statuses("claude-code", "sign-in-unknown", "provider-remove", separate)).toEqual({ steps: ["add:done", "sign-in:current"], combined: null });
  });
});

describe("providerSetupSteps — Claude Code × Higgsfield: one add that also signs in", () => {
  // libi's add script runs `claude mcp login` right after an add that worked (lib/agents/setup/scripts/add-provider.*).
  it("not added: both steps current, covered by one action", () => {
    expect(statuses("claude-code", "not-added")).toEqual({ steps: ["add:current", "sign-in:current"], combined: ["add", "sign-in"] });
  });

  it("a live add runs both steps", () => {
    expect(statuses("claude-code", "not-added", "provider-add")).toEqual({
      steps: ["add:running", "sign-in:running"],
      combined: ["add", "sign-in"],
    });
  });

  it("once detection shows the add, a sign-in Claude Code says is missing is still running under the live add", () => {
    expect(statuses("claude-code", "needs-sign-in", "provider-add")).toEqual({ steps: ["add:done", "sign-in:running"], combined: null });
    expect(statuses("claude-code", "sign-in-unknown", "provider-add")).toEqual({ steps: ["add:done", "sign-in:running"], combined: null });
  });

  it("signed in (Claude Code says Connected): both steps done, whatever the terminal is running", () => {
    for (const action of [null, "provider-add", "provider-sign-in", "provider-remove"] as const) {
      expect(statuses("claude-code", "connected", action)).toEqual({ steps: ["add:done", "sign-in:done"], combined: null });
    }
  });

  it("tokens that ran out: Sign in again is its own step, run by signin-provider", () => {
    expect(statuses("claude-code", "needs-sign-in")).toEqual({ steps: ["add:done", "sign-in:current"], combined: null });
    expect(statuses("claude-code", "needs-sign-in", "provider-sign-in")).toEqual({ steps: ["add:done", "sign-in:running"], combined: null });
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
  it("Higgsfield names both agents as agents whose add signs in", () => {
    expect(higgsfield.addSignsIn).toEqual(["codex", "claude"]);
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

// ElevenLabs is its hosted server now: the same two steps as Higgsfield. An older local entry that needs a key
// ("needs-key") is fixed by Replace, a single action, so it shows no stepper.
describe("providerSetupSteps — ElevenLabs, hosted: add, then sign in", () => {
  const elevenlabs = findProvider("elevenlabs");
  it("Claude Code's add signs in too, in one action; after it, a sign-in still missing is its own step", () => {
    expect(statuses("claude-code", "not-added", null, elevenlabs)).toEqual({ steps: ["add:current", "sign-in:current"], combined: ["add", "sign-in"] });
    expect(statuses("claude-code", "needs-sign-in", null, elevenlabs)).toEqual({ steps: ["add:done", "sign-in:current"], combined: null });
    expect(statuses("claude-code", "sign-in-unknown", null, elevenlabs)).toEqual({ steps: ["add:done", "sign-in:current"], combined: null });
  });
  it("Codex's add signs in too, in one action", () => {
    expect(statuses("codex", "not-added", null, elevenlabs)).toEqual({ steps: ["add:current", "sign-in:current"], combined: ["add", "sign-in"] });
  });
  // A working older local server (`uvx elevenlabs-mcp`, with a key) has no sign-in: no stepper claiming "Signed in".
  it.each(["claude-code", "codex"] as const)("a detected LOCAL entry on %s shows no steps in any state", (agentId) => {
    for (const state of ["connected", "needs-key", "cant-start", "disabled", "sign-in-unknown"] as const) {
      expect(providerSetupSteps({ def: elevenlabs, agentId, state, transport: "stdio" }), state).toBeNull();
    }
    expect(providerSetupSteps({ def: elevenlabs, agentId, state: "connected", transport: "http" })).not.toBeNull();
  });
  it.each(["claude-code", "codex"] as const)("a local entry that needs a key or can't start on %s shows no steps", (agentId) => {
    expect(statuses(agentId, "needs-key", null, elevenlabs)).toBeNull();
    expect(statuses(agentId, "cant-start", null, elevenlabs)).toBeNull();
  });
});
