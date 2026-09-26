"use client";

import { useEffect, useRef } from "react";
import { useMutation, useMutationState, type UseMutationResult } from "@tanstack/react-query";
import { toast } from "sonner";
import { restartSignals } from "@/hooks/sessions/restart-signals";

export const sessionRestartKeys = {
  all: ["session-restart"] as const,
};

export interface SessionRestartResponse {
  processRestarted: boolean;
}

/**
 * "Restart session" (`POST /api/sessions/:id/restart`): the chat is closed on the agent and loaded
 * again, conversation kept. The variables are the session id; the promise settles once the chat has
 * loaded again (or failed, with the server's plain-words reason as the error message). The chat
 * itself follows along over SSE (`session-restart` events in `useAgentChat`); this mutation is the
 * user's own wait, shown on the sidebar row (`useSessionRestarting`). Nothing to invalidate: the
 * load re-advertises the model and the slash commands, which reach their caches over SSE
 * (`agent-config-options`, `agent-commands`).
 */
export interface UseRestartSessionOptions {
  /** Whether `sessionId` is the chat the user is looking at right now. That chat says a failed
   *  restart itself, as an in-chat note (`useAgentChat`), so it gets no toast; any other chat's
   *  failure would otherwise go unsaid, so it gets one. Read when the restart fails, not when it
   *  starts — the user may have switched chats meanwhile. */
  isViewed?: (sessionId: string) => boolean;
}

/**
 * The failure toast is here, on the hook, and never on a `mutate(…, { onError })` call: TanStack
 * v5 runs a per-call callback only for the LAST `mutate` of an observer, so a second restart
 * started while the first was running would swallow the first one's failure.
 */
export function useRestartSession(
  options: UseRestartSessionOptions = {},
): UseMutationResult<SessionRestartResponse, Error, string> {
  const isViewedRef = useRef(options.isViewed);
  useEffect(() => {
    isViewedRef.current = options.isViewed;
  });
  return useMutation({
    mutationKey: sessionRestartKeys.all,
    mutationFn: async (sessionId: string): Promise<SessionRestartResponse> => {
      let res: Response;
      try {
        res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/restart`, { method: "POST" });
      } catch {
        throw new Error("libi's server didn't answer. Check that libi is still running, then try again.");
      }
      const body = (await res.json().catch(() => ({}))) as { error?: unknown; processRestarted?: unknown };
      if (!res.ok) {
        throw new Error(typeof body.error === "string" ? body.error : "libi couldn't restart this chat.");
      }
      return { processRestarted: body.processRestarted === true };
    },
    // The chat follows the restart over SSE; these are its fallback when that never arrives.
    onMutate: (sessionId) => restartSignals.requested(sessionId),
    onSuccess: (_data, sessionId) => restartSignals.settled(sessionId, { ok: true }),
    onError: (err, sessionId) => {
      restartSignals.settled(sessionId, { ok: false, error: err.message });
      if (!isViewedRef.current?.(sessionId)) {
        toast.error("Couldn't restart the chat", { description: err.message });
      }
    },
  });
}

/** Whether a restart the user started for `sessionId` is still running. */
export function useSessionRestarting(sessionId: string | null): boolean {
  const pending = useMutationState({
    filters: { mutationKey: sessionRestartKeys.all, status: "pending" },
    select: (mutation) => mutation.state.variables as string | undefined,
  });
  return sessionId !== null && pending.includes(sessionId);
}
