"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  SocialAccount,
  SocialPost,
  PostAnalytics,
  PieceAd,
  StoryInsights,
  PostListFilter,
  CreatePostInput,
  UpdatePostInput,
  TikTokCreatorInfo,
  TikTokDryRun,
  SocialAdAccount,
  SocialAdCampaign,
  AdListEntry,
} from "@/lib/social/types";
import type { SocialPlatform } from "@/lib/social/catalog";
import type { FitProbe, FitVerdict } from "@/lib/social/fit-check";
import type { SocialStatus } from "@/lib/social/service";
import type { SocialSettings } from "@/lib/db/settings";
import type { SocialPostLink } from "@/lib/social/links";

/**
 * Every social read is polled at this interval — but only while the page is
 * VISIBLE (`refetchIntervalInBackground: false`), and with a refetch on focus
 * so a tab that was hidden is fresh the moment it is looked at again. A hidden
 * tab polling a rate-limited provider every 30 s is how an account gets
 * throttled while nobody is watching.
 *
 * Polling is the FALLBACK path. In an in-app chat, a completed zernio write
 * invalidates these queries immediately over the SSE connection libi already
 * has (`lib/social/invalidation.ts` → `refresh_query { queryKey: "social" }` →
 * `dispatchRefreshQueryData`). Nothing here opens an EventSource of its own.
 */
export const SOCIAL_POLL_MS = 30_000;

export type SocialStatusResponse = SocialStatus & {
  catalog: Array<{ id: string; name: string; docsUrl: string; dashboardUrl: string }>;
  settings: SocialSettings;
};

/** The link row as it arrives over the wire: `Date` columns are ISO strings
 *  by the time JSON is done with them, and pretending otherwise would have
 *  components calling `.getTime()` on a string. */
export type SocialPostLinkJson = Omit<SocialPostLink, "createdAt" | "lastStatusAt"> & {
  createdAt: string;
  lastStatusAt: string | null;
};

/** A post from a list/detail read, decorated with the local link row —
 *  `null` for a post made outside libi (`isExternal`), which libi never
 *  linked to a piece. */
export type LinkedPost = SocialPost & { link: SocialPostLinkJson | null };
/** The Posting tab's read is driven BY the link table, so every row has one. */
export type PiecePost = SocialPost & { link: SocialPostLinkJson };

export interface SocialAdsResponse {
  accounts: SocialAdAccount[];
  campaigns: SocialAdCampaign[];
  /** Per connected account, the provider's OWN words for why its ads tree
   *  could not be read (e.g. an Instagram account with no linked Facebook).
   *  Non-empty alongside a non-empty `accounts` is normal — render it
   *  whenever it is non-empty, never only when the lists are empty. */
  unavailable: Array<{ accountId: string; message: string }>;
  /** Individual ads, each placed on its post / piece where libi can tell. */
  ads: AdListEntry[];
}

export const socialKeys = {
  all: ["social"] as const,
  status: ["social", "status"] as const,
  settings: ["social", "settings"] as const,
  accounts: ["social", "accounts"] as const,
  posts: (f?: PostListFilter) => ["social", "posts", f ?? {}] as const,
  post: (id: string) => ["social", "post", id] as const,
  analytics: (id: string) => ["social", "analytics", id] as const,
  piecePosts: (pieceId: string) => ["social", "piece", pieceId] as const,
  pieceAds: (pieceId: string) => ["social", "piece-ads", pieceId] as const,
  ads: ["social", "ads"] as const,
  creatorInfo: (accountId: string) => ["social", "creator-info", accountId] as const,
};

/** A social route's error, carrying the status and the route's own body —
 *  `retryAt` (429), `message` (422/501) and `perTarget` (207) are what the UI
 *  explains itself with. The routes never put a provider payload or a token
 *  in there (`lib/social/errors.ts`). */
export class SocialApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: { error?: string; retryAt?: string | null; message?: string; perTarget?: unknown },
  ) {
    super(body.error ?? `HTTP ${status}`);
    this.name = "SocialApiError";
  }
}

/**
 * A write that reached the provider and came back **207**: the post EXISTS,
 * and at least one target failed. The route's body is
 * `{ error: "partial", perTarget }` — never a post.
 *
 * It is a type of its own because 207 is `res.ok`, so a caller that assumed
 * `{ post }` read `undefined` off it and threw a `TypeError` ON TOP of a
 * half-published post — the one moment where a misleading error invites a
 * second post. Branch with `isPartialPost` rather than reaching for `.post`.
 */
export interface PartialPostResult {
  error: "partial";
  perTarget: Array<{ platform: SocialPlatform; accountId?: string; error: string }>;
}

export type WritePostResult = { post: SocialPost; deduped: boolean } | PartialPostResult;

export function isPartialPost(r: WritePostResult): r is PartialPostResult {
  return "perTarget" in r;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new SocialApiError(res.status, await res.json().catch(() => ({})));
  const body = (await res.json().catch(() => ({}))) as unknown;
  // 207 is `ok`, and its body is NOT the shape the 200 body has. Normalized
  // here so no caller has to remember that, and so a 207 that arrives without
  // its per-target list still reads as partial rather than as a post.
  if (res.status === 207) {
    const b = body as Partial<PartialPostResult>;
    return { error: "partial", perTarget: Array.isArray(b.perTarget) ? b.perTarget : [] } as T;
  }
  return body as T;
}

/**
 * When the provider itself said when to come back, in ISO. `null` otherwise —
 * including for a 429 with no `retryAt` — because a made-up retry moment
 * rendered as "retrying at 12:04" is worse than saying nothing.
 */
export function retryAtFor(err: unknown): string | null {
  return err instanceof SocialApiError ? err.body.retryAt ?? null : null;
}

export type SocialConnection = "unknown" | "no-provider" | "disconnected" | "needs-reconnect" | "connected";

/**
 * The connect panel's input. Not connected is DATA, not an error — and the
 * three not-connected states are different screens: no provider chosen yet,
 * never signed in ("Connect"), and a grant the provider revoked
 * ("Reconnect"). `needsReconnect` is only ever set from an OBSERVED 401, never
 * from a token-expiry countdown: a TikTok token legitimately expires daily and
 * Zernio refreshes it silently.
 */
export function socialConnection(status: Pick<SocialStatus, "providerId" | "connected" | "needsReconnect"> | undefined): SocialConnection {
  if (!status) return "unknown";
  if (!status.providerId) return "no-provider";
  if (status.connected) return "connected";
  return status.needsReconnect ? "needs-reconnect" : "disconnected";
}

/** No retries on 401/429: the page shows Reconnect / "retrying at hh:mm"
 *  instead of a toast storm, and a retried 429 just deepens the limit. */
const retry = (count: number, err: unknown) =>
  !(err instanceof SocialApiError && (err.status === 401 || err.status === 429)) && count < 1;

/** Auto-refresh (b): visible-only polling plus a focus refetch. */
const polled = {
  refetchInterval: SOCIAL_POLL_MS,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
  retry,
} as const;

export function useSocialStatus() {
  return useQuery({
    queryKey: socialKeys.status,
    queryFn: () => api<SocialStatusResponse>("/api/social/status"),
    staleTime: 10_000,
    retry,
  });
}

export function useSocialSettings() {
  return useQuery({
    queryKey: socialKeys.settings,
    queryFn: () => api<SocialSettings>("/api/social/settings"),
    staleTime: 10_000,
    retry,
  });
}

export function useSocialAccounts(enabled = true) {
  return useQuery({
    queryKey: socialKeys.accounts,
    queryFn: () => api<{ accounts: SocialAccount[] }>("/api/social/accounts").then((r) => r.accounts),
    enabled,
    ...polled,
  });
}

function postsQuery(filter: PostListFilter): string {
  const q = new URLSearchParams();
  if (filter.status?.length) q.set("status", filter.status.join(","));
  if (filter.platform) q.set("platform", filter.platform);
  if (filter.accountId) q.set("accountId", filter.accountId);
  if (filter.from) q.set("from", filter.from);
  if (filter.to) q.set("to", filter.to);
  if (filter.page) q.set("page", String(filter.page));
  if (filter.limit) q.set("limit", String(filter.limit));
  return q.toString();
}

export function useSocialPosts(filter: PostListFilter = {}, enabled = true) {
  return useQuery({
    queryKey: socialKeys.posts(filter),
    queryFn: () =>
      api<{ posts: LinkedPost[]; page: number; totalPages: number }>(`/api/social/posts?${postsQuery(filter)}`),
    enabled,
    ...polled,
  });
}

export function useSocialPost(id: string | null) {
  return useQuery({
    queryKey: socialKeys.post(id ?? ""),
    queryFn: () => api<LinkedPost>(`/api/social/posts/${encodeURIComponent(id!)}`),
    enabled: !!id,
    ...polled,
  });
}

/** Analytics are expensive and slow-moving; they also answer "still syncing"
 *  (`syncStatus`) rather than zeros, so the caller renders that state instead
 *  of polling it away. */
/**
 * Post analytics, plus `stories` for an Instagram Story — whose numbers the
 * post-analytics endpoint structurally never carries, so a Story's
 * `syncStatus` stays `pending` forever (see the route).
 */
export type SocialAnalyticsResponse = PostAnalytics & {
  stories?: Array<{ accountId: string; platformPostId: string; insights: StoryInsights }>;
};

export function useSocialPostAnalytics(id: string | null, enabled = true) {
  return useQuery({
    queryKey: socialKeys.analytics(id ?? ""),
    queryFn: () => api<SocialAnalyticsResponse>(`/api/social/posts/${encodeURIComponent(id!)}/analytics`),
    enabled: !!id && enabled,
    staleTime: 5 * 60_000,
    retry,
  });
}

/**
 * Analytics for a whole list of posts at once, keyed exactly like
 * `useSocialPostAnalytics` so a post opened in the detail sheet reuses what
 * the table already fetched. Returned as a map by post id — a table that
 * SORTS by these numbers needs them all in one place, not inside each row.
 */
export function useSocialPostsAnalytics(ids: string[]) {
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: socialKeys.analytics(id),
      queryFn: () => api<SocialAnalyticsResponse>(`/api/social/posts/${encodeURIComponent(id)}/analytics`),
      staleTime: 5 * 60_000,
      retry,
    })),
  });
  const byId = new Map<string, { data?: SocialAnalyticsResponse; isLoading: boolean }>();
  ids.forEach((id, i) => byId.set(id, { data: results[i]?.data, isLoading: !!results[i]?.isLoading }));
  return byId;
}

export function useSocialPiecePosts(pieceId: string, enabled = true) {
  return useQuery({
    queryKey: socialKeys.piecePosts(pieceId),
    queryFn: () =>
      api<{ posts: PiecePost[] }>(`/api/social/pieces/${encodeURIComponent(pieceId)}/posts`).then((r) => r.posts),
    enabled: !!pieceId && enabled,
    ...polled,
  });
}

/**
 * Every ad that belongs to this piece — boosts of its posts, discovered live
 * from the provider, plus ads libi was told about because they never were
 * posts. `unavailable` carries the provider's own words for an account with
 * no ads tree, which is a normal state, not a failure.
 */
export function useSocialPieceAds(pieceId: string, enabled = true) {
  return useQuery({
    queryKey: socialKeys.pieceAds(pieceId),
    queryFn: () =>
      api<{ ads: PieceAd[]; unavailable: Array<{ accountId: string; message: string }> }>(
        `/api/social/pieces/${encodeURIComponent(pieceId)}/ads`,
      ),
    enabled: !!pieceId && enabled,
    ...polled,
  });
}

export function useSocialAds(enabled = true) {
  return useQuery({
    queryKey: socialKeys.ads,
    queryFn: () => api<SocialAdsResponse>("/api/social/ads"),
    enabled,
    ...polled,
  });
}

export function useTikTokCreatorInfo(accountId: string | null) {
  return useQuery({
    queryKey: socialKeys.creatorInfo(accountId ?? ""),
    queryFn: () =>
      api<TikTokCreatorInfo>(`/api/social/tiktok/creator-info?accountId=${encodeURIComponent(accountId!)}`),
    enabled: !!accountId,
    staleTime: 10 * 60_000,
    retry,
  });
}

/**
 * Auto-refresh (c): libi's own write invalidates the social prefix, and only
 * that prefix. No optimistic local state anywhere in this file — the mutation
 * invalidates, the query refetches, the UI re-renders.
 */
function useSocialMutation<TArgs, TOut>(fn: (a: TArgs) => Promise<TOut>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: socialKeys.all }),
  });
}

export function useUpdateSocialSettings() {
  return useSocialMutation((s: SocialSettings) =>
    api<SocialSettings>("/api/social/settings", { method: "PUT", body: JSON.stringify(s) }),
  );
}

export function useCreateSocialPost() {
  return useSocialMutation((input: CreatePostInput & { exportPath?: string; createdBy?: "ui" | "agent" }) =>
    api<WritePostResult>("/api/social/posts", { method: "POST", body: JSON.stringify(input) }),
  );
}

/** Every caller of this hook is libi's own UI, so `createdBy: "ui"` is sent
 *  here rather than at each call site: the route's `createdBy` defaults to
 *  `"agent"` (drafts only) precisely so an omission is the safe answer. */
export function useUpdateSocialPost() {
  return useSocialMutation(({ id, ...patch }: UpdatePostInput & { id: string }) =>
    api<WritePostResult>(`/api/social/posts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ ...patch, createdBy: "ui" }),
    }),
  );
}

export function useDeleteSocialPost() {
  return useSocialMutation((id: string) =>
    api<{ ok: true }>(`/api/social/posts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  );
}

export function useRetrySocialPost() {
  return useSocialMutation((id: string) =>
    api<{ post: SocialPost; deduped: boolean }>(`/api/social/posts/${encodeURIComponent(id)}/retry`, {
      method: "POST",
    }),
  );
}

export interface SocialFitResponse {
  probe: FitProbe;
  verdicts: FitVerdict[];
}

/** One platform's answer from `POST /api/social/validate`. */
export interface SocialValidateVerdict {
  platform: string;
  ok: boolean;
  errors: string[];
}

/**
 * The composer's three checks, as queries rather than raw `fetch` in an
 * effect: keyed by the exact body they send, cached, and de-duplicated by
 * React Query like every other read in this file.
 *
 * `retry: false` on all three — a fit/validate answer is a verdict the user is
 * looking at, and a silent second attempt only delays the message.
 */
export function useSocialFit(input: { exportPath: string; targets: Array<{ platform: SocialPlatform; postType: string }> } | null) {
  const key = input ? JSON.stringify(input) : null;
  return useQuery({
    queryKey: [...socialKeys.all, "fit", key] as const,
    // The KEY is the body: a key that was merely "like" the body is how this
    // shipped sending a shape the route's schema did not take.
    queryFn: () => api<SocialFitResponse>("/api/social/fit", { method: "POST", body: key! }),
    enabled: !!key,
    staleTime: 60_000,
    retry: false,
  });
}

export function useValidateSocialPost(input: CreatePostInput | null) {
  const key = input ? JSON.stringify(input) : null;
  return useQuery({
    queryKey: [...socialKeys.all, "validate", key] as const,
    queryFn: () => api<SocialValidateVerdict[]>("/api/social/validate", { method: "POST", body: key! }),
    enabled: !!key,
    staleTime: 30_000,
    retry: false,
  });
}

/** TikTok's own pre-flight (`dryRun: true`). Advisory: it creates nothing. */
export function useTikTokDryRun(input: CreatePostInput | null, enabled: boolean) {
  const key = input ? JSON.stringify({ ...input, dryRun: true }) : null;
  return useQuery({
    queryKey: [...socialKeys.all, "dry-run", key] as const,
    queryFn: () => api<TikTokDryRun>("/api/social/validate", { method: "POST", body: key! }),
    enabled: enabled && !!key,
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * The `requestId` a compose flow must send for this logical post — decided by
 * the SERVER (`GET /api/social/request-id`), because the identity has to
 * survive the composer being closed and reopened. See that route for why a
 * per-mount `crypto.randomUUID()` is a double-post risk.
 */
export function useComposeRequestId(pieceId: string, postId: string | null) {
  const q = new URLSearchParams({ pieceId });
  if (postId) q.set("postId", postId);
  return useQuery({
    queryKey: [...socialKeys.all, "request-id", pieceId, postId ?? ""] as const,
    queryFn: () => api<{ requestId: string; source: "link" | "intent" | "fresh" }>(`/api/social/request-id?${q.toString()}`),
    // Never refetched: a second answer mid-compose would change the identity
    // of the post being composed, which is the whole thing this prevents.
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/**
 * Begin libi's own sign-in. Deliberately NOT invalidating: the grant has not
 * changed yet and this sign-in may never complete — the OAuth callback is what
 * resets the service, and its `refresh_query` is what refreshes these queries.
 */
export function useConnectLibi() {
  return useMutation({
    mutationFn: () => api<{ url: string }>("/api/social/oauth/start", { method: "POST" }),
  });
}

export function useDisconnectLibi() {
  // Explicit `void` — a zero-parameter `fn` gives the generic nothing to
  // infer TArgs from, which otherwise defaults to `unknown` and makes the
  // resulting `.mutate()` demand an argument no caller has to pass.
  return useSocialMutation<void, { ok: true }>(() => api<{ ok: true }>("/api/social/oauth/disconnect", { method: "POST" }));
}

/** `truncated` means the scan hit its page cap — say so, because a
 *  half-finished reindex looks exactly like a complete one. */
export function useReindexLinks() {
  return useSocialMutation<void, { scanned: number; linked: number; orphans: string[]; truncated: boolean }>(() =>
    api<{ scanned: number; linked: number; orphans: string[]; truncated: boolean }>(
      "/api/social/links?action=reindex",
      { method: "POST" },
    ),
  );
}

export function useLinkPost() {
  return useSocialMutation((b: { pieceId: string; providerPostId: string; exportPath?: string; createdBy?: "ui" | "agent" }) =>
    api<{ ok: true }>("/api/social/links", { method: "POST", body: JSON.stringify(b) }),
  );
}
