/**
 * The setup steps one agent takes for one provider, as data, for the Providers
 * tab's chips. A provider/agent pair with a single step (a keyed add: fal,
 * ElevenLabs) has no steps here and keeps its single-action chip; only a setup
 * of more than one step is listed, so every such setup reads the same way.
 *
 * Today the only multi-step setup is a provider the user signs in to with an
 * account (catalog `auth: "oauth"` with `signInCommands`): `add`, then
 * `sign-in`. Whether an agent's add ALSO performs the sign-in is catalog data
 * (`addSignsIn`), never a check on which agent it is.
 */

import type { ProviderScriptAction, SetupAgentId } from "@/lib/agents/setup/commands";
import type { ProviderDef } from "./catalog";
import type { ChipState } from "./chip-state";

export type SetupStepId = "add" | "sign-in";

/**
 * - `done`: detection shows the step happened.
 * - `current`: the next step to take.
 * - `locked`: waits on an earlier step.
 * - `blocked`: can't be taken from here until something outside these steps
 *   changes (an entry switched off in the agent's config).
 * - `running`: a current step whose command is live in the tab's terminal. The
 *   terminal outlives the command, so this never means the step is finishing:
 *   its action stays, and clicking it again types the command afresh.
 */
export type SetupStepStatus = "done" | "current" | "locked" | "blocked" | "running";

export interface SetupStep {
  id: SetupStepId;
  status: SetupStepStatus;
}

export interface SetupSteps {
  steps: SetupStep[];
  /**
   * The steps ONE action performs at once (in order, starting with the add),
   * while the add is still to do; null when each step has its own action. Once
   * the add is done, each remaining step has its own action, the same as an
   * agent whose add does not sign in.
   */
  combined: SetupStepId[] | null;
}

export interface SetupStepsInput {
  def: ProviderDef;
  agentId: SetupAgentId;
  state: ChipState;
  /** A Claude entry that arrived without its scope: the chip offers only Retry, so no steps. */
  scopeUnreadable?: boolean;
  /**
   * The provider command live in the tab's terminal for THIS provider and agent
   * (the terminal is anchored to this chip and has neither exited nor gone), if any.
   */
  liveAction?: ProviderScriptAction | null;
}

/** The command that performs each step on its own. */
const STEP_ACTION: Record<SetupStepId, ProviderScriptAction> = {
  add: "provider-add",
  "sign-in": "provider-sign-in",
};

function stepIds(def: ProviderDef): SetupStepId[] {
  if (!def.commands) return [];
  return def.auth === "oauth" && def.signInCommands ? ["add", "sign-in"] : ["add"];
}

/**
 * The steps, or null when the chip shows no stepper: a single-step setup, a
 * docs-only provider, or a state that claims nothing about the entry
 * (`unknown`, `agent-not-ready`, an unreadable scope). A Codex `stale` state is
 * a last known state and is listed like a fresh one; the chip marks it.
 */
export function providerSetupSteps({ def, agentId, state, scopeUnreadable, liveAction }: SetupStepsInput): SetupSteps | null {
  const ids = stepIds(def);
  if (ids.length < 2 || scopeUnreadable) return null;
  const addSignsIn = def.addSignsIn?.includes(agentId === "codex" ? "codex" : "claude") ?? false;
  // What the add command performs for this agent.
  const addCovers: SetupStepId[] = ids.filter((id) => id === "add" || (addSignsIn && id === "sign-in"));

  let base: Record<SetupStepId, SetupStepStatus>;
  switch (state) {
    case "not-added":
      base = { add: "current", "sign-in": addSignsIn ? "current" : "locked" };
      break;
    case "needs-sign-in":
    case "sign-in-unknown":
      base = { add: "done", "sign-in": "current" };
      break;
    case "disabled":
      // Switched off in the agent's config: nothing to sign in to until it is on again.
      base = { add: "done", "sign-in": "blocked" };
      break;
    case "connected":
      base = { add: "done", "sign-in": "done" };
      break;
    default:
      return null;
  }

  const performs = (id: SetupStepId): boolean =>
    liveAction != null && (liveAction === STEP_ACTION[id] || (liveAction === "provider-add" && addCovers.includes(id)));
  const steps = ids.map((id): SetupStep => {
    const status = base[id];
    return { id, status: status === "current" && performs(id) ? "running" : status };
  });
  return { steps, combined: addCovers.length > 1 && base.add !== "done" ? addCovers : null };
}
