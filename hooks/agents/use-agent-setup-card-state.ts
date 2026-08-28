"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useEditorState } from "@/lib/editor-state-context";
import {
  AGENT_DETECT_QUERY_KEY,
  isAgentInstallInFlight,
  useAgentInstall,
  useCancelAgentInstall,
  useStartAgentInstall,
} from "@/lib/queries/agent-setup";
import { useRunRemedyInTerminal } from "@/hooks/agents/use-run-remedy-in-terminal";
import type { TerminalRemedy } from "@/lib/agents/terminal-remedy";
import { trackEvent } from "@/lib/analytics/client";
import { toAgentEventId, type AnalyticsSurface } from "@/lib/analytics/events";
import type {
  AgentSetupMode,
  AgentSetupState,
} from "@/components/agents/agent-setup-card";

/**
 * The ONE derivation of "what should an agent-setup control show right now",
 * shared by all three surfaces that offer an install or a sign-in:
 * `components/onboarding/onboarding-panel.tsx`,
 * `components/sessions/agent-selector.tsx` and
 * `components/chat/chat-panel.tsx`.
 *
 * It shares the DERIVATION, not the markup. The sidebar's `InstallChip` is a
 * genuinely different rendering — a dropdown row, no space for a reason
 * sentence — and stays its own component; it just stops deriving its own
 * state from the raw job.
 *
 * An earlier review compared the three copies of that derivation, found the
 * fifteen lines identical, and concluded they were the same. They were not,
 * IN CONTEXT: each surface decides whether to render the control from a
 * DIFFERENT input, and only two of them had a recovery that matched their
 * input. Onboarding invalidates its own `/api/agent/detect` query; the
 * sidebar reads `provider.available`, which `refreshAgentProviders()`
 * updates. Chat derives from `readiness`, which is written ONLY by the
 * `agent-readiness` SSE broadcast or the `/api/agent/start` response — so
 * after a completed 345 MB install its card re-rendered "Install Claude Code"
 * on a machine where Claude Code now was installed, and pressing it again hit
 * `matching_completed` on a completed job and did nothing at all. Hence
 * `installCompleted` and `onInstallCompleted` below: completion handling
 * lives here once, and each surface says what recovery its own input needs.
 */
export interface AgentSetupCardState {
  /** What the control renders — the shared `AgentSetupCard` state union. */
  state: AgentSetupState;
  /**
   * An install started from THIS control has completed. Deliberately NOT
   * "the newest job happens to be completed": a surface whose visibility is
   * derived from stale input needs to know that the thing it is offering has
   * just been done, and a completed job left over from a previous process is
   * not an observation of that — it would suppress the install offer on a
   * machine where the agent really is missing, with no way back. Never true
   * in sign-in mode.
   */
  installCompleted: boolean;
  onAction: () => void;
  onRetry: () => void;
  onCancel: () => void;
}

export interface AgentSetupCardOptions {
  /** Where this control is rendered — reported with `agent_setup_started`. */
  surface: AnalyticsSurface;
  /** Called once when an install started here completes, for whatever extra
   *  recovery this surface's own input needs beyond the shared refresh. */
  onInstallCompleted?: () => void;
  /**
   * The sign-in command resolved for this agent on THIS machine, when the
   * surface already knows one. Sign-in mode only.
   *
   * With it, the action opens libi's Terminal on that command — which is what
   * a button reading "Sign in to X" promises. Without it, the action can only
   * connect the agent and see what happens; if that comes back `needs-auth`
   * carrying a remedy, the terminal opens from THAT, so the promise still
   * holds on the connect screen where nothing has been tried yet.
   */
  remedy?: TerminalRemedy | null;
}

/**
 * @param agentId The agent this control is for; `null` disables the install
 *   poll entirely (the surface isn't showing a specific agent yet).
 * @param mode Install or sign-in — decided by each surface from its own
 *   inputs, since they genuinely differ (detection, `provider.available`,
 *   readiness).
 */
export function useAgentSetupCardState(
  agentId: string | null,
  mode: AgentSetupMode,
  options: AgentSetupCardOptions,
): AgentSetupCardState {
  const { surface, onInstallCompleted, remedy = null } = options;

  const { activeProviderId, isAgentConnecting, selectAgent, refreshAgentProviders } =
    useEditorState();
  const queryClient = useQueryClient();
  const runRemedyInTerminal = useRunRemedyInTerminal();

  const pollAgentId = mode === "install" ? agentId : null;
  const { data: installStatus } = useAgentInstall(pollAgentId);
  const startInstall = useStartAgentInstall();
  const cancelInstall = useCancelAgentInstall();
  const job = installStatus?.job ?? null;

  // The agent whose install was actually SET IN MOTION from this control —
  // set in the click handler, so no ref is read during render and no state is
  // set inside an effect. Without it, a completed job left over from a
  // PREVIOUS process (the route serves the newest agent_install job for the
  // agent, whenever it ran) would read as "the user just finished
  // installing" — a state nobody observed. Worse, it would then suppress the
  // install offer on a machine where the agent really is gone, leaving no way
  // back.
  const [startedAgentId, setStartedAgentId] = useState<string | null>(null);
  const startedHere = startedAgentId !== null && startedAgentId === agentId;
  const installCompleted =
    mode === "install" && startedHere && job?.status === "completed";

  const handledJobId = useRef<string | null>(null);
  useEffect(() => {
    if (job?.status !== "completed" || handledJobId.current === job.id) return;
    handledJobId.current = job.id;
    // `agentProviders` is not React Query (plain fetch/useState in
    // lib/editor-state-context.tsx), so nothing invalidates it — a completed
    // install has to be pushed in explicitly or the agent stays greyed out
    // until reload. `/api/agent/detect` is React Query but equally stale.
    // Both fire once per completed job id, on every surface.
    refreshAgentProviders();
    void queryClient.invalidateQueries({ queryKey: AGENT_DETECT_QUERY_KEY });
    if (!startedHere) return;
    // Whatever else THIS surface's own input needs — see the module doc.
    // `onInstallCompleted` sits in the deps rather than a ref: the
    // `handledJobId` guard makes this effect a no-op on every run after the
    // first for a given job, so an unmemoized callback re-running it costs
    // nothing and cannot double-fire.
    onInstallCompleted?.();
  }, [job, refreshAgentProviders, queryClient, startedHere, onInstallCompleted]);

  const connecting = isAgentConnecting && activeProviderId === agentId;

  const state: AgentSetupState = (() => {
    if (mode !== "install") {
      return connecting ? { kind: "busy", label: "Connecting…" } : { kind: "idle" };
    }
    // The POST round-trip. All three surfaces used to derive state from the
    // job query alone, so between the click and the refetch the button still
    // read "Install Claude Code" and stayed enabled — an inert-looking
    // control that invites a second click.
    if (startInstall.isPending) return { kind: "busy", label: "Starting…" };
    if (job && isAgentInstallInFlight(job)) {
      return { kind: "working", doneMb: job.progressDone, totalMb: job.progressTotal };
    }
    // A POST that 400s or 500s was rendered nowhere at all: the click simply
    // did nothing, with the reason sitting unread in `startInstall.error`.
    if (startInstall.error) {
      return { kind: "failed", reason: startInstall.error.message };
    }
    if (!job) return { kind: "idle" };
    if (job.status === "cancelled") {
      // A cancel is not a failure — say what actually happened, so Retry
      // reads as "install again", not "try to fix whatever broke".
      return { kind: "failed", reason: "Install cancelled. Retry to install again." };
    }
    if (job.status === "failed") {
      return { kind: "failed", reason: job.error ?? "The install did not finish." };
    }
    return { kind: "idle" };
  })();

  const onAction = useCallback(() => {
    if (agentId === null) return;
    // Funnel steps 5 + 6. Emitted HERE rather than in `AgentSetupCard` so the
    // sidebar's own `InstallChip` — which deliberately renders differently
    // and therefore never used the card — reports its installs too. It
    // previously fired nothing, while `agent_install_completed` fires
    // server-side in the runner whatever started the job: the funnel showed
    // completions with no matching starts. `agent` is bounded via
    // `toAgentEventId`, so an id the registry adds later can never reach the
    // event unbounded — it just isn't reported until the vocabulary catches
    // up.
    const agent = toAgentEventId(agentId);
    if (agent) {
      trackEvent("agent_setup_started", {
        agent,
        action: mode === "install" ? "install" : "sign_in",
        surface,
      });
    }
    if (mode === "install") {
      setStartedAgentId(agentId);
      startInstall.mutate(agentId);
      return;
    }
    // Sign-in mode. This used to be `selectAgent(agentId)` and nothing else —
    // so a button labelled "Sign in to Codex", pressed on a card that exists
    // BECAUSE Codex rejected on auth, retried the identical call and got the
    // identical rejection. A loop, inside the feature built to remove loops.
    if (remedy) {
      void runRemedyInTerminal(remedy, agentId, surface);
      return;
    }
    // Nothing has been tried yet (the connect screen). Connect — and if that
    // is how we learn it needs signing in, carry straight on to the terminal
    // rather than making the user find the second button that does it.
    void (async () => {
      try {
        const readiness = await selectAgent(agentId);
        if (readiness?.state !== "needs-auth" || !readiness.remedy) return;
        await runRemedyInTerminal(readiness.remedy, agentId, surface);
      } catch {
        /* selectAgent already surfaces its own failure */
      }
    })();
    // `startInstall` / `selectAgent` are stable enough for this to be a
    // click handler; the identity churn a mocked mutation introduces in
    // tests costs nothing here.
  }, [agentId, mode, surface, startInstall, selectAgent, remedy, runRemedyInTerminal]);

  const onCancel = useCallback(() => {
    if (agentId !== null) cancelInstall.mutate(agentId);
  }, [agentId, cancelInstall]);

  return { state, installCompleted, onAction, onRetry: onAction, onCancel };
}
