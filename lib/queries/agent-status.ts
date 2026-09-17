import { useEffect } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryCacheNotifyEvent,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { AgentStatus } from "@/lib/agents/agent-status";
import type { SetupAgentId } from "@/lib/agents/setup/commands";
import type { JobStatusSnapshot } from "@/lib/jobs/types";

/**
 * `GET /api/agents/status` — per agent: the user's CLI, the adapter, sign-in and
 * libi-tools state. The Agents tab and its status bar read every agent; the setup
 * wizard polls ONE (`?agent=<id>`), so polling Claude never spawns codex.
 *
 * The adapter install hooks live here too: a completed install changes the
 * adapter half of the status, so both share one key namespace and an install
 * can invalidate the status from wherever it was started.
 */
export const agentStatusKeys = {
  all: ["agent-status"] as const,
  one: (agentId: string) => ["agent-status", agentId] as const,
  install: (agentId: string) => ["agent-status", "install", agentId] as const,
};

interface AgentStatusResponse {
  agents: Partial<Record<SetupAgentId, AgentStatus>>;
}

async function fetchAgentStatus(query: string): Promise<AgentStatusResponse> {
  const res = await fetch(`/api/agents/status${query}`);
  if (!res.ok) throw new Error(`agent status fetch failed (${res.status})`);
  return res.json();
}

async function fetchOneAgentStatus(agentId: SetupAgentId, refresh: boolean): Promise<AgentStatus> {
  const body = await fetchAgentStatus(`?agent=${encodeURIComponent(agentId)}${refresh ? "&refresh=1" : ""}`);
  const status = body.agents[agentId];
  if (!status) throw new Error(`agent status missing for ${agentId}`);
  return status;
}

/** One agent's status and when the read that produced it STARTED. The wizard
 *  judges a finished install only by a read that began after the job
 *  completed: a read that began before can land after completion and still say
 *  the adapter is missing. When a response arrived (`dataUpdatedAt`) cannot
 *  tell those apart. Both times come from this machine's clock, the same clock
 *  the server stamps `completedAt` with — the studio binds 127.0.0.1. */
export interface AgentStatusRead {
  status: AgentStatus;
  readStartedAt: number;
}

async function readOneAgentStatus(agentId: SetupAgentId, refresh: boolean): Promise<AgentStatusRead> {
  const readStartedAt = Date.now();
  const status = await fetchOneAgentStatus(agentId, refresh);
  return { status, readStartedAt };
}

export interface AgentStatusQueryOptions {
  refetchInterval?: number | false;
  enabled?: boolean;
}

/** Writes one agent's fresh status into the every-agent read, if that read is
 *  cached. The status bar reads every agent and does not poll, so without this
 *  it contradicts the wizard below it (which polls one agent) until the page is
 *  left. Patching rather than invalidating also keeps a one-agent read from
 *  re-resolving the other agent's CLI. */
function patchAllAgentStatus(qc: QueryClient, agentId: string, status: AgentStatus): void {
  qc.setQueryData<Partial<Record<SetupAgentId, AgentStatus>>>(agentStatusKeys.all, (prev) =>
    prev ? { ...prev, [agentId]: status } : prev,
  );
}

/**
 * Per query client: the one cache subscription that carries accepted one-agent
 * reads into the every-agent read, and how current the every-agent read is.
 *
 * It is a cache subscription held for the client's whole lifetime (the app's
 * QueryProvider starts it when it creates the client), not something the status
 * hooks hold while mounted. A poll still in flight when the wizard closes lands
 * with no observer mounted, and an every-agent fetch can land after the page
 * was left: the first must still reach the status bar, and the second must
 * still count as newer than a one-agent read that began before it. It sees
 * only results React Query ACCEPTED: an invalidation cancels an in-flight
 * fetch so its stale answer is dropped, but the fetch itself still resolves,
 * and a patch made from inside it would already have written that answer. It
 * never replays a read that was cached before it saw it land.
 *
 * "How current" is kept as start times, because a read that began before the
 * every-agent read was fetched can land after it and must not overwrite it.
 */
interface StatusForwarding {
  /** Whether the client's cache subscription has been started. */
  subscribed: boolean;
  /** When the latest every-agent fetch STARTED. */
  allFetchStartedAt: number;
  /** When the fetch behind the cached every-agent read started. */
  allReadStartedAt: number;
  /** agentId -> when the one-agent read last written into it started. */
  agentReadStartedAt: Map<string, number>;
}

const statusForwarding = new WeakMap<QueryClient, StatusForwarding>();

function forwardingFor(qc: QueryClient): StatusForwarding {
  let state = statusForwarding.get(qc);
  if (!state) {
    state = { subscribed: false, allFetchStartedAt: 0, allReadStartedAt: 0, agentReadStartedAt: new Map() };
    statusForwarding.set(qc, state);
  }
  return state;
}

function forwardAcceptedRead(qc: QueryClient, state: StatusForwarding, event: QueryCacheNotifyEvent): void {
  if (event.type !== "updated" || event.action.type !== "success") return;
  const [root, agentId, ...rest] = event.query.queryKey;
  if (root !== agentStatusKeys.all[0]) return;
  if (agentId === undefined) {
    // A fetched every-agent read replaced every agent's status. The patches
    // below are manual writes and leave these times alone.
    if (!event.action.manual) {
      state.allReadStartedAt = state.allFetchStartedAt;
      state.agentReadStartedAt.clear();
    }
    return;
  }
  if (rest.length > 0 || typeof agentId !== "string" || agentId === "") return;
  const read = event.query.state.data as AgentStatusRead | undefined;
  if (!read) return;
  const currentAsOf = Math.max(state.allReadStartedAt, state.agentReadStartedAt.get(agentId) ?? 0);
  if (read.readStartedAt < currentAsOf) return;
  state.agentReadStartedAt.set(agentId, read.readStartedAt);
  patchAllAgentStatus(qc, agentId, read.status);
}

/** Carries accepted one-agent status reads into the every-agent read for as
 *  long as `qc` lives. The app's QueryProvider calls it once, as it creates the
 *  client, so it is in place before anything can fetch. Calling it again for the
 *  same client does nothing. */
export function forwardAgentStatusReads(qc: QueryClient): void {
  const state = forwardingFor(qc);
  if (state.subscribed) return;
  state.subscribed = true;
  qc.getQueryCache().subscribe((event) => forwardAcceptedRead(qc, state, event));
}

const selectStatus = (read: AgentStatusRead): AgentStatus => read.status;
const selectRead = (read: AgentStatusRead): AgentStatusRead => read;

function useOneAgentStatusQuery<T>(
  agentId: SetupAgentId | null,
  opts: AgentStatusQueryOptions,
  select: (read: AgentStatusRead) => T,
): UseQueryResult<T> {
  return useQuery({
    queryKey: agentStatusKeys.one(agentId ?? ""),
    queryFn: () => readOneAgentStatus(agentId as SetupAgentId, false),
    enabled: agentId !== null && (opts.enabled ?? true),
    refetchInterval: opts.refetchInterval ?? false,
    select,
  });
}

/** `agentId: null` disables the query. */
export function useAgentStatus(
  agentId: SetupAgentId | null,
  opts: AgentStatusQueryOptions = {},
): UseQueryResult<AgentStatus> {
  return useOneAgentStatusQuery(agentId, opts, selectStatus);
}

/** The same read as `useAgentStatus`, with when it started. `agentId: null` disables it. */
export function useAgentStatusRead(
  agentId: SetupAgentId | null,
  opts: AgentStatusQueryOptions = {},
): UseQueryResult<AgentStatusRead> {
  return useOneAgentStatusQuery(agentId, opts, selectRead);
}

/** Every agent. Each fetch records when it started, so a one-agent read that
 *  began before it is never written over its result. */
export function useAllAgentStatus(
  opts: AgentStatusQueryOptions = {},
): UseQueryResult<Partial<Record<SetupAgentId, AgentStatus>>> {
  const qc = useQueryClient();
  return useQuery({
    queryKey: agentStatusKeys.all,
    queryFn: async () => {
      forwardingFor(qc).allFetchStartedAt = Date.now();
      return (await fetchAgentStatus("")).agents;
    },
    enabled: opts.enabled ?? true,
    refetchInterval: opts.refetchInterval ?? false,
  });
}

/** "Check again": re-resolves the agent's CLI on the server instead of serving
 *  the memo. The read is written into the agent's own query; the forwarding
 *  subscription carries it into the every-agent read. */
export function useRecheckAgentCli(): UseMutationResult<AgentStatusRead, Error, SetupAgentId> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agentId: SetupAgentId) => readOneAgentStatus(agentId, true),
    onSuccess: (read, agentId) => {
      qc.setQueryData(agentStatusKeys.one(agentId), read);
    },
  });
}

/** "I've signed in" / "I'm already signed in": stores the user's word that the
 *  agent's CLI is signed in. libi cannot observe a sign-in without spending a
 *  prompt, and the confirmation also clears an older observed rejection, so
 *  every agent status is invalidated once it is stored. */
export function useConfirmAgentSignIn(): UseMutationResult<void, Error, SetupAgentId> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: SetupAgentId): Promise<void> => {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/sign-in-confirmation`, { method: "POST" });
      if (!res.ok) throw new Error(`sign-in confirmation failed (${res.status})`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: agentStatusKeys.all });
    },
  });
}

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

/** `agentId: null` disables the query. Polls every 2s while an install is in
 *  flight, not at all otherwise. A completed install invalidates the agent
 *  status, so the adapter half flips to ready without a reload — once per job,
 *  so a fresh install that completes after an older completed one still does. */
export function useAgentInstall(
  agentId: string | null,
): UseQueryResult<AgentInstallStatusDto> {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: agentStatusKeys.install(agentId ?? ""),
    queryFn: () => fetchAgentInstall(agentId as string),
    enabled: agentId !== null,
    refetchInterval: (query) => {
      const dto = query.state.data as AgentInstallStatusDto | undefined;
      return isAgentInstallInFlight(dto?.job) ? 2000 : false;
    },
  });
  const jobId = q.data?.job?.id;
  const status = q.data?.job?.status;
  useEffect(() => {
    if (jobId !== undefined && status === "completed") void qc.invalidateQueries({ queryKey: agentStatusKeys.all });
  }, [jobId, status, qc]);
  return q;
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
    // for the poll interval to come round. This fires when the queueing POST
    // settles, NOT when the job completes — completion reaches the status
    // through useAgentInstall.
    onSettled: (_data, _err, agentId) => {
      void qc.invalidateQueries({ queryKey: agentStatusKeys.install(agentId) });
      void qc.invalidateQueries({ queryKey: agentStatusKeys.all });
    },
  });
}
