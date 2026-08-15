"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { subscribeBroadcast } from "./use-agent-chat";
import type { AgentReadiness } from "@/lib/agents/agent-readiness";

const UNKNOWN_READINESS: AgentReadiness = { state: "unknown" };

export interface SessionListItem {
  sessionId: string;
  agentId: string;
  title: string | null;
  updatedAt: string | null;
  active: boolean;
}

export interface SessionGroup {
  label: string;
  sessions: SessionListItem[];
}

function groupSessionsByDay(sessions: SessionListItem[]): SessionGroup[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  const groups = new Map<string, SessionListItem[]>();

  for (const session of sessions) {
    const date = session.updatedAt ? new Date(session.updatedAt) : new Date(0);
    let label: string;

    if (date >= startOfToday) {
      label = "Today";
    } else if (date >= startOfYesterday) {
      label = "Yesterday";
    } else {
      label = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }

    const list = groups.get(label) ?? [];
    list.push(session);
    groups.set(label, list);
  }

  // Convert to array, preserving insertion order (sessions are already sorted by updatedAt desc)
  return [...groups.entries()].map(([label, sessions]) => ({ label, sessions }));
}

/**
 * The outcome of a session-creation attempt.
 *
 * `createSession()` collapses this to `sessionId | null` for the callers that
 * only branch on success. It used to be the ONLY shape, and that is how a real
 * `500 {"error":"Authentication required"}` from POST /api/sessions became
 * invisible: `if (!res.ok) return null` threw the server's explanation away and
 * the sidebar rendered a permanently-disabled "+" that claimed to be
 * "Preparing a new chat session…". Anything that can show a message should use
 * `createSessionWithResult()` and surface `error`.
 */
export interface CreateSessionResult {
  sessionId: string | null;
  error: string | null;
}

export interface UseSessionList {
  sessions: SessionListItem[];
  groups: SessionGroup[];
  isLoading: boolean;
  /** True while createSession() is in flight. */
  isCreating: boolean;
  /** True when the server has a pre-warmed standby ACP session ready to be
   *  claimed by the next createSession() call. When false, the next click
   *  would fall through to a fresh `conn.newSession` (5–15s), so the UI
   *  disables the "New chat" button until the server re-emits standby-ready. */
  canCreate: boolean;
  /** The agent currently active on the server (from SessionManager). Sourced
   *  from /api/sessions so the UI reflects what the server actually has warmed
   *  rather than relying on a stale client-side cache. Null until the initial
   *  fetch returns or while no agent is active. */
  activeAgentId: string | null;
  /**
   * Whether the ACTIVE agent can actually be chatted with right now — as
   * distinct from "is it installed". Sourced from GET /api/sessions on load and
   * kept live by the `agent-readiness` SSE broadcast. Defaults to
   * `{ state: "unknown" }`, which asserts nothing: a UI must not read it as
   * health, only as "nothing has failed yet".
   */
  readiness: AgentReadiness;
  /** Readiness for any agent we've heard about (the selector badges each row). */
  readinessFor: (agentId: string) => AgentReadiness;
  /** Message from the last failed createSession(), or null. */
  createError: string | null;
  activeSessionId: string | null;
  setActiveSessionId: (sessionId: string | null) => void;
  createSession: () => Promise<string | null>;
  /** Same call as createSession(), but hands back the server's error text. */
  createSessionWithResult: () => Promise<CreateSessionResult>;
  switchSession: (sessionId: string) => void;
  refresh: () => void;
}

interface SessionsResponse {
  sessions?: SessionListItem[];
  activeAgentId?: string | null;
  standbyReady?: boolean;
  /** Readiness of `activeAgentId` at the time of the response. */
  readiness?: AgentReadiness;
}

export function useSessionList(): UseSessionList {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [standbyReady, setStandbyReady] = useState(true);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [readinessByAgent, setReadinessByAgent] = useState<
    Record<string, AgentReadiness>
  >({});
  const [createError, setCreateError] = useState<string | null>(null);

  const fetchSessions = useCallback(() => {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((data: SessionsResponse) => {
        setSessions(data.sessions ?? []);
        if (typeof data.standbyReady === "boolean") {
          setStandbyReady(data.standbyReady);
        }
        // Server is the source of truth for which agent is currently active.
        // `undefined` means the field wasn't returned (older shape) — leave as-is.
        // `null` means explicitly no active agent — clear local state.
        if (data.activeAgentId !== undefined) {
          setActiveAgentId(data.activeAgentId);
        }
        // The response carries ONE readiness — the active agent's — so it is
        // only meaningful when we also know who that agent is.
        if (data.readiness && data.activeAgentId) {
          const agentId = data.activeAgentId;
          const readiness = data.readiness;
          setReadinessByAgent((prev) =>
            prev[agentId] === readiness ? prev : { ...prev, [agentId]: readiness },
          );
        }
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, []);

  // Fetch on mount
  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Track standby-ready transitions pushed by the server over SSE, so the
  // "New chat" button stays disabled for the full replenishment window and
  // every click feels equally responsive. Also use the ready=true edge as a
  // signal that the server finished warming an agent on startup — refetch so
  // we pick up its activeAgentId without relying on the client's initial poll
  // racing the server's warm-up.
  useEffect(() => {
    const unsub = subscribeBroadcast((data) => {
      if (data.type === "standby-ready") {
        const ready = Boolean(data.ready);
        setStandbyReady(ready);
        if (ready) fetchSessions();
      }
      // Readiness is pushed the moment the server LEARNS it (a session/new
      // resolving or rejecting), which is the only honest moment — nothing
      // here infers it, and nothing polls for it.
      if (data.type === "agent-readiness") {
        const agentId = data.agentId as string | undefined;
        const readiness = data.readiness as AgentReadiness | undefined;
        if (agentId && readiness) {
          setReadinessByAgent((prev) => ({ ...prev, [agentId]: readiness }));
          // A recovered agent should not keep showing the failure that got it
          // into this state.
          if (readiness.state === "ready") setCreateError(null);
        }
      }
    });
    return unsub;
  }, [fetchSessions]);

  const createSessionWithResult =
    useCallback(async (): Promise<CreateSessionResult> => {
    // Guard against double-invocation. React effects or an impatient user
    // clicking faster than state propagates would otherwise fire two POSTs;
    // only the first would claim the standby, and the second would wait on
    // a fresh ACP `newSession` round-trip (5–15s).
    if (isCreating) return { sessionId: null, error: null };
    setIsCreating(true);
    setCreateError(null);
    // Optimistically flip standby to "not ready" — the server will emit a
    // standby-ready event once replenishment succeeds, which re-enables the
    // button. This avoids a brief window where the button re-enables between
    // the response arriving and the SSE event arriving.
    setStandbyReady(false);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        // THE bug this hook shipped with: `return null` here discarded a real
        // `500 {"error":"Authentication required"}` and left the UI with
        // nothing but a disabled button to render.
        const body = (await res.json().catch(() => ({}))) as {
          error?: unknown;
        };
        const message =
          typeof body.error === "string" && body.error.trim()
            ? body.error
            : `Couldn't start a chat session (HTTP ${res.status}).`;
        setCreateError(message);
        return { sessionId: null, error: message };
      }
      const data = (await res.json()) as { sessionId: string };

      // Optimistically insert a placeholder so the new session shows up in the
      // sidebar under "Today" before the refetch round-trips. The refetch below
      // will replace it with the canonical server entry.
      setSessions((prev) => {
        if (prev.some((s) => s.sessionId === data.sessionId)) return prev;
        const placeholder: SessionListItem = {
          sessionId: data.sessionId,
          agentId: "",
          title: null,
          updatedAt: new Date().toISOString(),
          active: true,
        };
        return [placeholder, ...prev];
      });
      setActiveSessionId(data.sessionId);
      fetchSessions();
      return { sessionId: data.sessionId, error: null };
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : "Couldn't reach the libi server to start a chat session.";
      setCreateError(message);
      return { sessionId: null, error: message };
    } finally {
      setIsCreating(false);
    }
  }, [fetchSessions, isCreating]);

  const createSession = useCallback(
    async (): Promise<string | null> =>
      (await createSessionWithResult()).sessionId,
    [createSessionWithResult],
  );

  const switchSession = useCallback(
    (sessionId: string): void => {
      // Clicking the ALREADY-selected session used to be a pure client-side
      // no-op (a same-value setState fires no effects), which left the user
      // with no recovery when the server-side session had been quietly
      // deactivated — e.g. after switching agents away and back. Re-trigger
      // server-side activation through the same endpoint the chat panel's
      // history fetch uses; `activateSession` returns the warm cache
      // immediately when the session is genuinely active, so the healthy
      // case stays a cheap no-op.
      if (sessionId === activeSessionId) {
        void fetch(
          `/api/agent/messages?sessionId=${encodeURIComponent(sessionId)}`,
        ).catch(() => {});
        return;
      }
      // Just set the active session. The chat panel's message fetch will
      // activate the session on the server (GET /api/agent/messages calls
      // activateSession under the hood with dedup), so we don't need a
      // separate POST /activate round-trip and the race it introduced.
      setActiveSessionId(sessionId);
    },
    [activeSessionId],
  );

  const groups = useMemo(() => groupSessionsByDay(sessions), [sessions]);

  const readinessFor = useCallback(
    (agentId: string): AgentReadiness =>
      readinessByAgent[agentId] ?? UNKNOWN_READINESS,
    [readinessByAgent],
  );

  const readiness = activeAgentId
    ? (readinessByAgent[activeAgentId] ?? UNKNOWN_READINESS)
    : UNKNOWN_READINESS;

  return useMemo(
    () => ({
      sessions,
      groups,
      isLoading,
      isCreating,
      canCreate: !isCreating && standbyReady,
      activeAgentId,
      readiness,
      readinessFor,
      createError,
      activeSessionId,
      setActiveSessionId,
      createSession,
      createSessionWithResult,
      switchSession,
      refresh: fetchSessions,
    }),
    [
      sessions,
      groups,
      isLoading,
      isCreating,
      standbyReady,
      activeAgentId,
      readiness,
      readinessFor,
      createError,
      activeSessionId,
      setActiveSessionId,
      createSession,
      createSessionWithResult,
      switchSession,
      fetchSessions,
    ],
  );
}
