import type { AgentStatus } from "@/lib/agents/agent-status";
import type { SetupAgentId } from "@/lib/agents/setup/commands";
import type { OnboardingWizardUpdate } from "@/lib/queries/onboarding";
import type { AgentsTabOnboarding } from "./onboarding-visit";
import { firstIncompleteStep, type WizardStep } from "./wizard-state";

/**
 * What the Agents tab decides by itself, as plain functions of what it knows:
 * whether a `?agent=` deep link opens a wizard, and the one wizard the tab may
 * open on its own each time it mounts. User actions (a row click, a pick, Close)
 * change the state directly; `settleAgentsTab` is everything else.
 */

export interface OpenWizard {
  agent: SetupAgentId | null;
  step: WizardStep;
}

export interface AgentsTabState {
  wizard: OpenWizard | null;
  /** The wizard this mount may open by itself has been decided on — opened, or not. */
  autoOpenDecided: boolean;
  /** The `?agent=` value already acted on, so Close stays closed until the URL drops it. */
  consumedAgent: SetupAgentId | null;
  /** The onboarding save the tab's latest decision calls for. A new object for each decision. */
  save: OnboardingWizardUpdate | null;
}

export const INITIAL_AGENTS_TAB: AgentsTabState = {
  wizard: null,
  autoOpenDecided: false,
  consumedAgent: null,
  save: null,
};

export interface AgentsTabFacts {
  phase: AgentsTabOnboarding | null;
  resumeHandled: boolean;
  /** The agent onboarding recorded as being set up. */
  chosenAgent: SetupAgentId | null;
  /** `?agent=`. */
  deepLink: SetupAgentId | null;
  /** The live status of `statusAgentFor`'s agent, once known. */
  status: AgentStatus | undefined;
  /** The status is known, or could not be read. */
  statusSettled: boolean;
}

export function onboardingUnfinished(phase: AgentsTabOnboarding | null): boolean {
  return phase === "first" || phase === "resume";
}

/** The agent whose status the tab's next decision needs: the deep link's, or the chosen one's while that decision is pending. */
export function statusAgentFor(
  state: AgentsTabState,
  { phase, chosenAgent, deepLink }: Pick<AgentsTabFacts, "phase" | "chosenAgent" | "deepLink">,
): SetupAgentId | null {
  if (deepLink !== null) return deepLink;
  return !state.autoOpenDecided && onboardingUnfinished(phase) ? chosenAgent : null;
}

/** An agent's first incomplete step; a status that could not be read opens at step 2. */
function stepFor(status: AgentStatus | undefined): WizardStep {
  return status ? firstIncompleteStep(status) : 2;
}

/**
 * `?agent=` opens the wizard for that agent at its first incomplete step once its
 * status is known — once per value, and only while no wizard is open: a wizard
 * the user already opened wins, and the deep link is consumed without opening
 * anything. During an unfinished onboarding the deep link is also the user's pick
 * (and opens on an unreadable status too, rather than leave a first onboarding on
 * its skeleton).
 */
function adoptDeepLink(state: AgentsTabState, facts: AgentsTabFacts): AgentsTabState {
  const { deepLink, phase, status, statusSettled } = facts;
  if (deepLink === state.consumedAgent) return state;
  if (deepLink === null) return { ...state, consumedAgent: null };
  if (state.wizard !== null) return { ...state, consumedAgent: deepLink };
  const unfinished = onboardingUnfinished(phase);
  if (!status && !(unfinished && statusSettled)) return state;
  return {
    ...state,
    consumedAgent: deepLink,
    wizard: { agent: deepLink, step: stepFor(status) },
    save: unfinished ? { wizardAgentChosen: deepLink } : state.save,
  };
}

/**
 * The one wizard a mount opens by itself: step 1 for a first onboarding; for a
 * resume, once per visit, the chosen agent at its first incomplete step — but
 * only while that agent still has a step before Open chat. One with nothing left
 * but Open chat is set up: the tab stays on the rows and records the wizard as
 * finished, as Open chat would, so the next visit doesn't ask again.
 */
function decideAutoOpen(state: AgentsTabState, facts: AgentsTabFacts): AgentsTabState {
  const { phase, resumeHandled, chosenAgent, deepLink, status, statusSettled } = facts;
  if (state.autoOpenDecided) return state;
  const decided = { ...state, autoOpenDecided: true };
  if (phase === "done" || deepLink !== null || state.wizard !== null || (phase === "resume" && resumeHandled)) {
    return decided;
  }
  if (chosenAgent === null) return phase === "first" ? { ...decided, wizard: { agent: null, step: 1 } } : decided;
  if (!statusSettled) return state;
  const step = stepFor(status);
  if (phase === "resume" && step === 4) return { ...decided, save: { wizardFinished: true } };
  return { ...decided, wizard: { agent: chosenAgent, step } };
}

/** The tab once `facts` are taken into account. Returns `state` itself when nothing changes. */
export function settleAgentsTab(state: AgentsTabState, facts: AgentsTabFacts): AgentsTabState {
  if (facts.phase === null) return state;
  return decideAutoOpen(adoptDeepLink(state, facts), facts);
}
