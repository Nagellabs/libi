"use client";

import { useEffect, useState } from "react";
import type { SetupAgentId } from "@/lib/agents/setup/commands";
import { useAgentStatus } from "@/lib/queries/agent-status";
import { readHasFailed, useOnboardingState, useUpdateOnboardingState } from "@/lib/queries/onboarding";
import { useClearAgentParam } from "../use-agents-page-params";
import {
  INITIAL_AGENTS_TAB,
  onboardingUnfinished,
  settleAgentsTab,
  statusAgentFor,
  type AgentsTabState,
} from "./agents-tab-state";
import { OnboardingVisitProvider, useOnboardingVisit } from "./onboarding-visit";
import { StatusBar, StatusBarSkeleton } from "./status-bar";
import { Wizard } from "./wizard";

/**
 * The agent status bar and, below it, the setup wizard when one is open. This
 * tab owns which wizard is open and at which step.
 *
 * Onboarding decides what the tab shows (`AgentsTabOnboarding`): a first
 * onboarding is the wizard alone, opened at step 1 even when Claude Code or Codex
 * is already on the machine — the rows would only raise questions the wizard
 * answers. An agent chosen but never finished brings the rows back on the next
 * visit, with the wizard reopened for that agent where it left off while there is
 * a step left before Open chat. Once the wizard has been finished, the tab is the
 * rows, and a wizard only on request. The decisions themselves are
 * `agents-tab-state.ts`.
 *
 * On the Agents page the tab reads the page's onboarding visit; rendered alone,
 * it keeps one of its own for as long as it is mounted.
 */
export function AgentsTab({ agent }: { agent: SetupAgentId | null }) {
  return (
    <OnboardingVisitProvider>
      <AgentsTabContent agent={agent} />
    </OnboardingVisitProvider>
  );
}

function AgentsTabContent({ agent }: { agent: SetupAgentId | null }) {
  const onboarding = useOnboardingState();
  const { mutate: saveOnboarding } = useUpdateOnboardingState();
  const { phase, resumeHandled, markResumeHandled } = useOnboardingVisit();
  const chosenAgent = onboarding.data?.wizardAgent ?? null;
  const unfinished = onboardingUnfinished(phase);

  const [tab, setTab] = useState<AgentsTabState>(INITIAL_AGENTS_TAB);
  const agentStatus = useAgentStatus(statusAgentFor(tab, { phase, chosenAgent, deepLink: agent }));
  const settled = settleAgentsTab(tab, {
    phase,
    resumeHandled,
    chosenAgent,
    deepLink: agent,
    status: agentStatus.data,
    // Settled by the first failed request, not after the retries (`readHasFailed`).
    statusSettled: agentStatus.data !== undefined || readHasFailed(agentStatus),
  });
  // What just became known (the phase, a deep link, a status) is taken in during
  // this render — React's previous-state pattern, not an effect — so a wizard
  // appears in the same paint as what opened it. `settleAgentsTab` returns the
  // state itself once there is nothing left to take in, which ends the re-render.
  if (settled !== tab) setTab(settled);

  // The save a decision called for goes out once the decision is committed.
  useEffect(() => {
    if (tab.save !== null) saveOnboarding(tab.save);
  }, [tab.save, saveOnboarding]);

  useEffect(() => {
    if (phase === "resume" && tab.autoOpenDecided) markResumeHandled();
  }, [phase, tab.autoOpenDecided, markResumeHandled]);

  // A consumed deep link leaves the URL. This tab unmounts on every tab switch,
  // so a param left behind would be adopted again on return and re-open a wizard
  // the user closed. The wizard itself lives in state and stays open.
  const clearAgentParam = useClearAgentParam();
  useEffect(() => {
    if (agent !== null && agent === tab.consumedAgent) clearAgentParam();
  }, [agent, tab.consumedAgent, clearAgentParam]);

  // Until the onboarding state is known — and in a first onboarding, until its
  // wizard can open — the tab is its skeleton, so status rows never flash up
  // before a wizard replaces them.
  if (phase === null || (phase === "first" && tab.wizard === null)) {
    return <StatusBarSkeleton testId="agents-tab-skeleton" />;
  }

  const { wizard } = tab;
  // The setup terminal is deliberately NOT closed here, neither on Close nor when
  // the wizard moves to another agent: a command the user already submitted (an
  // installer, a browser sign-in, a chained reconnect) would be killed mid-run.
  // The wizard shows the terminal only under the agent whose step opened it, so
  // another agent's wizard never offers that command, and reopening the owner's
  // wizard shows it again. Its own Close button, leaving the page, the idle
  // reaper and the next command a step opens are what end it.
  return (
    <div className="space-y-6" data-testid="agents-tab">
      {phase === "first" ? null : (
        <StatusBar onOpenWizard={(a, step) => setTab((t) => ({ ...t, wizard: { agent: a, step } }))} />
      )}
      {wizard ? (
        <Wizard
          agent={wizard.agent}
          step={wizard.step}
          onStep={(step) => setTab((t) => (t.wizard ? { ...t, wizard: { ...t.wizard, step } } : t))}
          onAgent={(a) => {
            setTab((t) => ({ ...t, wizard: { agent: a, step: 2 } }));
            if (unfinished) saveOnboarding({ wizardAgentChosen: a });
          }}
          // A first onboarding is the wizard and nothing else, so there is nothing to close it to.
          onClose={phase === "first" ? undefined : () => setTab((t) => ({ ...t, wizard: null }))}
          onFinish={unfinished ? () => saveOnboarding({ wizardFinished: true }) : undefined}
        />
      ) : null}
    </div>
  );
}
