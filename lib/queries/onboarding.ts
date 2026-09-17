import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { toast } from "sonner";
import type { SetupAgentId } from "@/lib/agents/setup/commands";

/**
 * `GET /api/onboarding/state` — where the user is in first-run onboarding: the
 * persona question, the demo offer, and the Agents tab's setup wizard. Read by
 * the editor (whether a first launch belongs on the Agents tab), the persona
 * question and the Agents tab.
 */
export interface OnboardingState {
  needsPersona: boolean;
  persona: string | null;
  needsOnboarding: boolean;
  agentEverConnected: boolean;
  demoOffered: boolean;
  /** When the user first picked an agent in the setup wizard, as an ISO string; null = never. */
  wizardAgentChosenAt: string | null;
  /** The agent being set up: the latest pick, until the wizard is finished. */
  wizardAgent: SetupAgentId | null;
  /** When the wizard first reached its end (Open chat succeeded), as an ISO string; null = never. */
  wizardFinishedAt: string | null;
  /** The wizard counts as finished — see the route for installs from before it was recorded. */
  wizardFinished: boolean;
}

export const onboardingKeys = {
  state: ["onboarding-state"] as const,
};

/**
 * A read that has failed at least once. The app sets no retries of its own, so
 * React Query retries a failing read three times, and reports it as an error
 * only after about seven seconds. Onboarding never holds anyone on a skeleton
 * through that: the first failed request counts as unreadable, the retries go
 * on quietly, and the caller keeps its first decision rather than following a
 * late answer. Used for the onboarding state and the agent status alike.
 */
export function readHasFailed(query: Pick<UseQueryResult<unknown>, "isError" | "failureCount">): boolean {
  return query.isError || query.failureCount > 0;
}

export function useOnboardingState(): UseQueryResult<OnboardingState> {
  return useQuery({
    queryKey: onboardingKeys.state,
    queryFn: async (): Promise<OnboardingState> => {
      const res = await fetch("/api/onboarding/state");
      if (!res.ok) throw new Error(`onboarding state fetch failed (${res.status})`);
      return res.json();
    },
  });
}

/** What the setup wizard records about its own progress. */
export type OnboardingWizardUpdate = { wizardAgentChosen: SetupAgentId } | { wizardFinished: true };

/**
 * `PUT /api/onboarding/state`. The server keeps only the first time of each, so a
 * repeat is harmless — which is what makes the one retry safe. A lost pick matters:
 * an agent that later connects with no pick recorded counts the user as set up.
 */
export function useUpdateOnboardingState(): UseMutationResult<OnboardingState, Error, OnboardingWizardUpdate> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (update: OnboardingWizardUpdate): Promise<OnboardingState> => {
      const res = await fetch("/api/onboarding/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
      if (!res.ok) throw new Error(`onboarding state update failed (${res.status})`);
      return res.json();
    },
    retry: 1,
    // The server answers with the state the save left behind, so the cache takes
    // that at once: a tab switch right after the pick reads the pick, not step 1.
    onSuccess: (state) => {
      qc.setQueryData(onboardingKeys.state, state);
    },
    onError: (err, update) => {
      console.error("[onboarding] saving setup progress failed", err);
      toast.error(
        "wizardAgentChosen" in update
          ? "Couldn't save which agent you're setting up. libi may ask you to choose again next time."
          : "Couldn't save that setup is finished. The setup wizard may open again next time.",
      );
    },
  });
}
