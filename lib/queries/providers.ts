"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { DetectedMcp, ProviderDetection } from "@/lib/providers/detect";
import type { ProviderId } from "@/lib/providers/catalog";

// ── Types ───────────────────────────────────────────────────────────

/** What `GET /api/providers` answers. `error` is set when detection failed
 *  and the list is empty for that reason rather than because nothing is
 *  configured. `codex` is set when Codex's rows are not a fresh answer: `stale`
 *  rows are codex's last good listing, and `unread` means there are no Codex
 *  rows because codex gave no listing (see `ProviderDetection`). */
export type ProvidersResponse = { connected: DetectedMcp[]; error?: string; codex?: ProviderDetection["codex"] };

// ── Query keys ──────────────────────────────────────────────────────

export const providerKeys = {
  all: ["providers"] as const,
  legacy: ["providers", "legacy"] as const,
};

/** One entry of `GET /api/providers/legacy` — see `lib/providers/legacy.ts`. */
export type LegacyKeyNotice = {
  rowId: string;
  providerId: ProviderId;
  providerName: string;
  command: string;
  commands: { claude: string; codex: string };
};

// ── Queries ─────────────────────────────────────────────────────────

async function fetchProviders(query = ""): Promise<ProvidersResponse> {
  const res = await fetch(`/api/providers${query}`);
  if (!res.ok) throw new Error("failed to read providers");
  return (await res.json()) as ProvidersResponse;
}

/**
 * The MCP servers the user's agents already have, read from the agents' own
 * config. The detector spawns codex, so the default poll is deliberately slower
 * than the health card's: 10 s is often enough to catch a connect the user just
 * ran in the built-in Terminal without hammering it. A host that knows when a
 * command may be running passes its own `refetchInterval` (the Providers tab
 * polls only while its setup terminal is live, and not at all otherwise).
 */
export function useProviders({
  enabled = true,
  refetchInterval = 10_000,
}: { enabled?: boolean; refetchInterval?: number | false } = {}) {
  return useQuery({
    enabled,
    queryKey: providerKeys.all,
    queryFn: () => fetchProviders(),
    refetchInterval,
  });
}

/**
 * Retry. A plain refetch can be answered from the server's 5 s memo of a codex
 * listing that just failed, so this reads with `?refresh=1`, which asks codex
 * again (joining a listing already running), and writes the answer into
 * `useProviders`' cache.
 */
export function useRefreshProviders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => fetchProviders("?refresh=1"),
    onSuccess: async (data) => {
      // A poll that started before the Retry must not land over its answer.
      await qc.cancelQueries({ queryKey: providerKeys.all, exact: true });
      qc.setQueryData(providerKeys.all, data);
    },
  });
}

/**
 * The one-time notice for a key libi stored before it stopped taking keys.
 * Read once when the panel mounts — no interval: the list only
 * ever shrinks, and it shrinks through `useAcknowledgeLegacyKey` below.
 */
export function useLegacyKeyNotices({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    enabled,
    queryKey: providerKeys.legacy,
    queryFn: async (): Promise<{ notices: LegacyKeyNotice[] }> => {
      const res = await fetch("/api/providers/legacy");
      if (!res.ok) throw new Error("failed to read legacy provider keys");
      return (await res.json()) as { notices: LegacyKeyNotice[] };
    },
  });
}

// ── Mutations ───────────────────────────────────────────────────────

/** "I've copied it": sets `shownAt` and deletes the stored value for good. */
export function useAcknowledgeLegacyKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rowId: string) => {
      const res = await fetch("/api/providers/legacy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rowId }),
      });
      if (!res.ok) throw new Error("failed to clear the legacy provider key");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: providerKeys.legacy }),
  });
}
