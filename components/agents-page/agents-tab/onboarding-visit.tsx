"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { readHasFailed, useOnboardingState, type OnboardingState } from "@/lib/queries/onboarding";

/**
 * How the Agents tab treats setup:
 * - `first` — the user's first onboarding: the wizard alone, no status rows.
 * - `resume` — an agent was chosen but the wizard never finished: the rows, and
 *   the wizard reopened for that agent while it still has a step before Open chat.
 * - `done` — the wizard has been finished once: the rows, and a wizard only when
 *   the user opens one.
 */
export type AgentsTabOnboarding = "first" | "resume" | "done";

export function agentsTabOnboarding(
  state: Pick<OnboardingState, "wizardAgentChosenAt" | "wizardFinished">,
): AgentsTabOnboarding {
  if (state.wizardFinished) return "done";
  return state.wizardAgentChosenAt === null ? "first" : "resume";
}

/**
 * What one visit to the Agents page has settled about onboarding. The Agents tab
 * unmounts on every tab switch, so this lives on the page: a first onboarding
 * stays wizard-only for the whole visit even once its pick is recorded, and an
 * unfinished setup is reopened once per visit, not on every return to the tab.
 * Leaving the page or reloading starts a new visit.
 */
export interface OnboardingVisit {
  /** The first onboarding phase this visit saw; null until the onboarding state is known. */
  phase: AgentsTabOnboarding | null;
  /** Whether this visit has already decided about reopening a resumed setup. */
  resumeHandled: boolean;
  markResumeHandled: () => void;
}

function useVisit(): OnboardingVisit {
  const onboarding = useOnboardingState();
  const [kept, setKept] = useState<AgentsTabOnboarding | null>(null);
  const [resumeHandled, setResumeHandled] = useState(false);
  // An unreadable state must not trap anyone in onboarding: the tab as usual,
  // from the first failed request rather than after React Query's retries.
  const phase =
    kept ?? (onboarding.data ? agentsTabOnboarding(onboarding.data) : readHasFailed(onboarding) ? "done" : null);

  // Kept the moment it is known, during this render (React's previous-state
  // pattern), so recording a first onboarding's pick — or a retry answering
  // late — cannot change it mid-visit.
  if (kept === null && phase !== null) setKept(phase);

  const markResumeHandled = useCallback(() => setResumeHandled(true), []);
  return useMemo(() => ({ phase, resumeHandled, markResumeHandled }), [phase, resumeHandled, markResumeHandled]);
}

const OnboardingVisitContext = createContext<OnboardingVisit | null>(null);

function VisitScope({ children }: { children: ReactNode }) {
  const visit = useVisit();
  return <OnboardingVisitContext.Provider value={visit}>{children}</OnboardingVisitContext.Provider>;
}

/**
 * A visit for everything below it — unless a provider above already gives one,
 * which is then left in place. The Agents page provides the visit its tabs
 * share; the Agents tab wraps itself in a provider too, so on the page it starts
 * no visit of its own, and rendered alone it gets one that lasts as long as it
 * is mounted.
 */
export function OnboardingVisitProvider({ children }: { children: ReactNode }) {
  const outer = useContext(OnboardingVisitContext);
  return outer ? <>{children}</> : <VisitScope>{children}</VisitScope>;
}

/** The visit of the nearest `OnboardingVisitProvider`. */
export function useOnboardingVisit(): OnboardingVisit {
  const visit = useContext(OnboardingVisitContext);
  if (visit === null) throw new Error("useOnboardingVisit must be used under an OnboardingVisitProvider");
  return visit;
}
