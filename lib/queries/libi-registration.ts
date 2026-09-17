"use client";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { LibiRegistrations } from "@/lib/agents/libi-registration";

// ── Query keys ──────────────────────────────────────────────────────

export const libiRegistrationKeys = { all: ["libi-registration"] as const };

// ── Queries ─────────────────────────────────────────────────────────

async function fetchLibiRegistration(query = ""): Promise<LibiRegistrations> {
  const res = await fetch(`/api/agents/libi-registration${query}`);
  if (!res.ok) throw new Error("failed to read libi's registration");
  return ((await res.json()) as { agents: LibiRegistrations }).agents;
}

/**
 * Whether libi is registered with the user's own Claude Code / Codex, and on
 * which port. The server memoizes 5 s per agent (the Codex half spawns
 * `codex mcp list`), so a faster `refetchInterval` only re-reads the memo.
 */
export function useLibiRegistration(
  { enabled = true, refetchInterval = false }: { enabled?: boolean; refetchInterval?: number | false } = {},
): UseQueryResult<LibiRegistrations> {
  return useQuery({
    enabled,
    queryKey: libiRegistrationKeys.all,
    queryFn: () => fetchLibiRegistration(),
    refetchInterval,
  });
}

/**
 * Retry. A plain refetch can be answered from the server's 5 s memo of a codex
 * listing that just failed, so this reads with `?refresh=1`, which asks codex
 * again (joining a listing already running), and writes the answer into
 * `useLibiRegistration`'s cache.
 */
export function useRefreshLibiRegistration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => fetchLibiRegistration("?refresh=1"),
    onSuccess: async (agents) => {
      // A poll that started before the Retry must not land over its answer.
      await qc.cancelQueries({ queryKey: libiRegistrationKeys.all, exact: true });
      qc.setQueryData(libiRegistrationKeys.all, agents);
    },
  });
}
