import { useQueries, useQuery } from "@tanstack/react-query";

/**
 * Per-video filmstrip-sprite status polling. Mirrors the proxy-status polling
 * pattern: poll every 2s while `idle | queued | generating`, stop once
 * `ready | failed`. The first fetch hits `?ensure=1` so the server lazily
 * enqueues generation when the sprite doesn't exist yet — the editor never
 * has to imperatively kick off filmstrip gen.
 */
export interface FilmstripStatus {
  status: "idle" | "queued" | "generating" | "ready" | "failed";
  filename: string | null;
  frames: number | null;
  height: number | null;
  generatedAt: string | null;
}

export const filmstripKeys = {
  status: (fileId: string) => ["filmstrip-status", fileId] as const,
};

const POLL_MS = 2000;

async function fetchFilmstripStatus(fileId: string): Promise<FilmstripStatus> {
  // ensure=1: lazily enqueue generation server-side when idle/failed. Cheap +
  // idempotent (the server no-ops when generating/ready).
  const res = await fetch(
    `/api/files/by-id/${fileId}/filmstrip-status?ensure=1`,
  );
  if (!res.ok) throw new Error(`filmstrip-status ${res.status}`);
  return (await res.json()) as FilmstripStatus;
}

function isTerminal(status: FilmstripStatus["status"] | undefined): boolean {
  return status === "ready" || status === "failed";
}

/** Returns the sprite serve URL for a fileId — the place to point a CSS
 *  background-image once status is `ready`. */
export function filmstripUrl(fileId: string): string {
  return `/api/files/by-id/${fileId}/filmstrip`;
}

/** Single-file status. Thin wrapper over the batched form. */
export function useFilmstripStatus(fileId: string | null | undefined) {
  return useQuery({
    queryKey: filmstripKeys.status(fileId ?? ""),
    enabled: !!fileId,
    queryFn: () => fetchFilmstripStatus(fileId as string),
    // Poll until terminal, then stop. `query.state.data` is the last result.
    refetchInterval: (query) =>
      isTerminal(query.state.data?.status) ? false : POLL_MS,
    staleTime: POLL_MS,
  });
}

/**
 * Batched status for many video fileIds — the centralized call the Timeline
 * makes once for every distinct video fileId, so bars don't each open a poll.
 * Returns a Map keyed by fileId.
 */
export function useFilmstripStatuses(
  fileIds: string[],
): Map<string, FilmstripStatus | undefined> {
  // Dedup + stable order so the query set is stable across renders.
  const ids = Array.from(new Set(fileIds.filter(Boolean))).sort();
  const results = useQueries({
    queries: ids.map((fileId) => ({
      queryKey: filmstripKeys.status(fileId),
      queryFn: () => fetchFilmstripStatus(fileId),
      refetchInterval: (query: {
        state: { data?: FilmstripStatus };
      }) => (isTerminal(query.state.data?.status) ? false : POLL_MS),
      staleTime: POLL_MS,
    })),
  });

  const map = new Map<string, FilmstripStatus | undefined>();
  ids.forEach((fileId, i) => {
    map.set(fileId, results[i]?.data);
  });
  return map;
}
