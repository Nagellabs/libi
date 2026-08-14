"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  SessionUsageState,
  AvailableCommandInfo,
} from "@/lib/sessions/usage";
import { sessionContextEmitter } from "@/hooks/sessions/use-agent-chat";

export interface SessionContextData {
  usage: SessionUsageState | null;
  commands: AvailableCommandInfo[];
}

export const sessionContextKeys = {
  detail: (sessionId: string) => ["session-context", sessionId] as const,
};

const EMPTY: SessionContextData = { usage: null, commands: [] };

/**
 * Usage + advertised slash commands for a session. Fetches the snapshot on
 * mount / session switch; live agent-usage / agent-commands SSE events patch
 * the cache via sessionContextEmitter (no refetch, no extra EventSource).
 */
export function useSessionContext(sessionId: string | null): SessionContextData {
  const queryClient = useQueryClient();

  useEffect(() => {
    return sessionContextEmitter.on((event) => {
      queryClient.setQueryData<SessionContextData>(
        sessionContextKeys.detail(event.sessionId),
        (old) => {
          const base = old ?? EMPTY;
          return event.kind === "usage"
            ? { ...base, usage: event.usage }
            : { ...base, commands: event.commands };
        },
      );
    });
  }, [queryClient]);

  const query = useQuery({
    queryKey: sessionContextKeys.detail(sessionId ?? "none"),
    enabled: !!sessionId,
    staleTime: Infinity, // SSE keeps it fresh between mounts
    // The SSE listener above seeds cache entries for ANY session that emits
    // (not just the watched one). With staleTime: Infinity alone, such a
    // partial seed would suppress the authoritative snapshot fetch on a
    // later switch to that session — losing snapshot-only state like
    // `commands` advertised before any listener existed. Always fetching on
    // mount closes that hole; between mounts SSE patches keep it live.
    refetchOnMount: "always",
    queryFn: async (): Promise<SessionContextData> => {
      const res = await fetch(`/api/sessions/${sessionId}/context`);
      if (res.status === 404) return EMPTY; // unknown session → empty state
      if (!res.ok) {
        // Transient failures must throw so React Query retries/refetches —
        // returning EMPTY here would cache-poison the session permanently
        // under staleTime: Infinity.
        throw new Error(`session context fetch failed: HTTP ${res.status}`);
      }
      return (await res.json()) as SessionContextData;
    },
  });

  return query.data ?? EMPTY;
}
