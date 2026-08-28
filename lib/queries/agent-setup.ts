import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { JobStatusSnapshot } from "@/lib/jobs/types";

/**
 * Backs the Claude Code "Install" button on the connect-agent card (Stage 4).
 * `GET /api/agents/[agentId]/install` reads the newest `agent_install` job
 * for that agent — see the header comment on the route for why it's a
 * kind-scoped read rather than a paramsHash lookup.
 *
 * Polling copies `lib/queries/runtime-update.ts`'s asymmetry: every 2s while
 * an install is in flight, not at all otherwise. There is no server-side
 * cache to protect here (the read is one indexed DB query), but a card
 * nobody is looking at an install through has no reason to poll either.
 *
 * `agentProviders` (the installed-CLI list the rest of the app reads to
 * decide whether an agent is selectable) is fetched OUTSIDE React Query —
 * plain `fetch`/`useState` in `lib/editor-state-context.tsx`, refreshed via
 * its exposed `refreshAgentProviders()`. There is no query key for it to
 * invalidate here. Doing that on a completed job is the job of
 * `hooks/agents/use-agent-setup-card-state.ts`, which every surface that
 * offers an install goes through — that is the ONE place completion is
 * handled, so a finished install makes the agent selectable without a page
 * reload wherever it was started from. Do not re-derive install state from
 * these primitives in a component; use that hook.
 */

export const agentSetupKeys = {
  all: ["agent-setup"] as const,
  install: (agentId: string) => ["agent-setup", "install", agentId] as const,
};

/** `GET /api/agent/detect` — the installed/not-installed answer the connect
 *  screen reads. Lives here, next to the install mutation that invalidates
 *  it, rather than inside the one panel that happens to fetch it: a completed
 *  install has to invalidate this from wherever it was started, and a query
 *  key defined in a component can only be reached by that component. */
export const AGENT_DETECT_QUERY_KEY = ["agent-detect"] as const;

export interface AgentInstallStatusDto {
  job: JobStatusSnapshot | null;
}

/** True while the job is still doing something — the same three statuses
 *  `isInstallInFlight` in runtime-update.ts treats as "in flight". */
export function isAgentInstallInFlight(
  job: JobStatusSnapshot | null | undefined,
): boolean {
  const s = job?.status;
  return s === "queued" || s === "running" || s === "cancel-requested";
}

async function fetchAgentInstall(agentId: string): Promise<AgentInstallStatusDto> {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/install`);
  if (!res.ok) throw new Error(`agent install status fetch failed (${res.status})`);
  return res.json();
}

/** `agentId: null` disables the query — e.g. the card isn't showing a
 *  specific agent yet. */
export function useAgentInstall(
  agentId: string | null,
): UseQueryResult<AgentInstallStatusDto> {
  return useQuery({
    queryKey: agentSetupKeys.install(agentId ?? ""),
    queryFn: () => fetchAgentInstall(agentId as string),
    enabled: agentId !== null,
    refetchInterval: (query) => {
      const dto = query.state.data as AgentInstallStatusDto | undefined;
      return isAgentInstallInFlight(dto?.job) ? 2000 : false;
    },
  });
}

interface StartAgentInstallResponse {
  jobId: string;
  status: string;
}

/** The click that starts (or attaches to) an install. Takes the agentId as
 *  its mutate variable, same shape as `useCancelJob`'s jobId. */
export function useStartAgentInstall(): UseMutationResult<
  { jobId: string },
  Error,
  string
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: string): Promise<{ jobId: string }> => {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/install`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Install failed to start (${res.status})`);
      }
      const dto = (await res.json()) as StartAgentInstallResponse;
      return { jobId: dto.jobId };
    },
    // Refetch immediately so the card flips to "installing" without waiting
    // for the poll interval to come round — same reasoning as
    // useInstallRuntimeUpdate's onSettled.
    onSettled: (_data, _err, agentId) => {
      void qc.invalidateQueries({ queryKey: agentSetupKeys.install(agentId) });
    },
  });
}

/** Cancel an in-flight install. */
export function useCancelAgentInstall(): UseMutationResult<void, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: string): Promise<void> => {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/install`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`cancel failed (${res.status})`);
    },
    onSettled: (_data, _err, agentId) => {
      void qc.invalidateQueries({ queryKey: agentSetupKeys.install(agentId) });
    },
  });
}
