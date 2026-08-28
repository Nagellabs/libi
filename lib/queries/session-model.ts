"use client";

import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SessionModelSnapshot } from "@/lib/sessions/model-option";
import { sessionModelEmitter } from "@/hooks/sessions/use-agent-chat";

/** GET/PATCH response shape. `pending: true` = "not known yet" (activation
 *  replay in flight) — render a skeleton, not nothing; the
 *  agent-config-options SSE event resolves it. */
export type SessionModelResponse = SessionModelSnapshot;

export const sessionModelKeys = {
  detail: (sessionId: string) => ["session-model", sessionId] as const,
};

/**
 * Model state for a session. Fetches the snapshot on mount / session switch;
 * live agent-config-options SSE events patch the cache via
 * sessionModelEmitter (no refetch, no extra EventSource) — the same shape as
 * useSessionContext, which this predated and now mirrors.
 */
export function useSessionModel(sessionId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    return sessionModelEmitter.on((event) => {
      // The event can land while this session's GET is still in flight —
      // switching sessions mid-activation is enough, since the remount's
      // `refetchOnMount: "always"` fetch and the activation's terminal emit
      // race. Without the cancel, the older response resolves LAST and
      // overwrites this snapshot with the `pending: true` the server gave
      // before activation finished; under `staleTime: Infinity` nothing ever
      // re-emits, so the skeleton pulses forever. Same idiom
      // `useSetSessionModel.onMutate` below uses for the same reason.
      void queryClient.cancelQueries({
        queryKey: sessionModelKeys.detail(event.sessionId),
      });
      queryClient.setQueryData<SessionModelResponse>(
        sessionModelKeys.detail(event.sessionId),
        event.model,
      );
    });
  }, [queryClient]);

  return useQuery({
    queryKey: sessionModelKeys.detail(sessionId ?? "none"),
    enabled: !!sessionId,
    staleTime: Infinity, // SSE keeps it fresh between mounts
    // The SSE listener above seeds cache entries for ANY session that emits
    // (not just the watched one). Always fetching on mount keeps the
    // authoritative snapshot from being suppressed by such a seed — the same
    // hole useSessionContext closes the same way.
    refetchOnMount: "always",
    queryFn: async (): Promise<SessionModelResponse> => {
      const res = await fetch(`/api/sessions/${sessionId}/model`);
      if (!res.ok) throw new Error("Failed to fetch session model");
      return (await res.json()) as SessionModelResponse;
    },
  });
}

export function useSetSessionModel(sessionId: string | null) {
  const queryClient = useQueryClient();
  const key = sessionModelKeys.detail(sessionId ?? "none");

  return useMutation({
    mutationFn: async (vars: { modelId: string }): Promise<void> => {
      const res = await fetch(`/api/sessions/${sessionId}/model`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Failed to set model");
      }
    },
    // Optimistic: the pill swaps to the new model immediately.
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<SessionModelResponse>(key);
      queryClient.setQueryData<SessionModelResponse>(key, (old) =>
        old && old.supported
          ? { ...old, currentModelId: vars.modelId }
          : old,
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev !== undefined) queryClient.setQueryData(key, ctx.prev);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: key });
    },
  });
}
