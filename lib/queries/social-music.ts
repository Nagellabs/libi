import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { KnownPlatform } from "@/lib/social/catalog";
import type { AccountMusicFacts, CatalogTrack, MusicCatalogResult, MusicMode } from "@/lib/social/music-policy";
import type { PiecePlan } from "@/lib/social/music-plan";
import { socialKeys } from "@/lib/queries/social";

/** Under `socialKeys.all`, so every `refresh_query { queryKey: "social" }` and every social mutation refreshes them. */
export const socialMusicKeys = {
  facts: [...socialKeys.all, "music-facts"] as const,
  catalog: (platform: string, accountId: string, q?: string) => [...socialKeys.all, "music-catalog", platform, accountId, q ?? ""] as const,
  plan: (pieceId: string, key: string) => [...socialKeys.all, "music-plan", pieceId, key] as const,
  /** Every plan of one piece (a prefix of `plan`). */
  planForPiece: (pieceId: string) => [...socialKeys.all, "music-plan", pieceId] as const,
  track: (accountId: string, trackId: string) => [...socialKeys.all, "music-track", accountId, trackId] as const,
};

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { message?: string; error?: string }).message ?? (body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export function useSocialMusicFacts(enabled = true) {
  return useQuery({
    queryKey: socialMusicKeys.facts,
    queryFn: () => json<{ facts: Record<string, AccountMusicFacts> }>("/api/social/music/facts"),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useSetTikTokKind() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { accountId: string; tiktokKind: "business" | "personal" }) =>
      json<{ facts: Record<string, AccountMusicFacts> }>("/api/social/music/facts", { method: "PUT", body: JSON.stringify(b) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: socialKeys.all }),
  });
}

/**
 * A post's own music override — what the USER chose for this one post (a mode
 * that is the post's alone, or a pick still being written to the song). Never
 * derived from a plan's resolved music: an automatic match is the song's, not
 * the post's.
 */
export type MusicChoice = { mode?: MusicMode; trackId?: string; soundName?: string };

export type MusicPlanTarget = { platform: KnownPlatform; accountId?: string; music?: MusicChoice };

const planQuery = (pieceId: string, target: MusicPlanTarget | null) => ({
  queryKey: socialMusicKeys.plan(pieceId, JSON.stringify(target)),
  queryFn: () => json<PiecePlan>("/api/social/music/plan", { method: "POST", body: JSON.stringify({ pieceId, targets: [target] }) }),
});

/**
 * The server's plan for ONE target (`POST /api/social/music/plan`, the same resolver `libi.post_piece` uses). Keyed by the target's content.
 * A changed override is a new key: the previous plan stays on screen until the new one answers
 * (`isPlaceholderData`), so a pick never swaps the Music card for a skeleton and remounts its picker.
 */
export function useMusicPlan(pieceId: string, target: MusicPlanTarget | null) {
  return useQuery({ ...planQuery(pieceId, target), enabled: !!target, staleTime: 60_000, placeholderData: keepPreviousData });
}

/**
 * Fetch one target's plan fresh into the cache — so a block about to switch
 * to that target's key shows the current plan, not a stale cached one (a
 * pick written to the song changes what an override-free plan resolves to).
 */
export function useFetchMusicPlan() {
  const qc = useQueryClient();
  return (pieceId: string, target: MusicPlanTarget) => qc.fetchQuery({ ...planQuery(pieceId, target), staleTime: 0 });
}

export function useMusicCatalog(platform: "instagram" | "tiktok", accountId: string, q?: string, enabled = true) {
  return useQuery({
    queryKey: socialMusicKeys.catalog(platform, accountId, q),
    enabled,
    staleTime: 5 * 60_000,
    queryFn: () =>
      json<MusicCatalogResult>(`/api/social/music/catalog?platform=${platform}&accountId=${encodeURIComponent(accountId)}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  });
}

export function useCatalogTrack(accountId: string, trackId: string, enabled: boolean) {
  return useQuery({
    queryKey: socialMusicKeys.track(accountId, trackId),
    enabled,
    staleTime: 10 * 60_000,
    queryFn: () => json<{ track: CatalogTrack | null }>(`/api/social/music/track?accountId=${encodeURIComponent(accountId)}&trackId=${encodeURIComponent(trackId)}`),
  });
}
