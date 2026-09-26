"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { trackEvent } from "@/lib/analytics/client";
import { Button } from "@/components/ui/button";
import { AskAgentButton } from "@/components/social/ask-agent-button";
import { AnalyticsPanel } from "@/components/social/analytics-panel";
import { ConnectLibiEmptyState } from "@/components/social/connect-libi-empty-state";
import { PostDetailSheet } from "@/components/social/post-detail-sheet";
import { PostListSkeleton } from "@/components/social/social-skeletons";
import { PostRow } from "@/components/social/post-row";
import { Composer } from "@/components/social/composer/composer";
import type { LatestExport } from "@/components/social/composer/types";
import { platformLabel } from "@/lib/social/catalog";
import { CONTENT_TYPE_LABEL, postEntryLabel, postTypes, whenLabel } from "@/lib/social/format";
import { AdRow, NETWORK_GLYPH, adEntryLabel } from "@/components/social/ad-row";
import { PostNav, postAnchorId, type PostNavItem } from "@/components/social/post-nav";
import { useAllJobs } from "@/lib/queries/jobs";
import { usePiece } from "@/lib/queries/pieces";
import { useSocialPieceAds, useSocialPiecePosts, useSocialStatus } from "@/lib/queries/social";
import { consumePostingIntent, requestExportDialog, usePostingIntent } from "@/hooks/social/use-posting-intent";

/** One export job's recorded result — a subset of `ExportSuccess`
 *  (`hooks/editor/use-export-flow.ts`), read back off the job row rather than
 *  a live export flow. Unknown/missing fields make the row unusable rather
 *  than guessed at. */
interface ExportJobResult {
  filePath?: unknown;
  width?: unknown;
  height?: unknown;
  sizeBytes?: unknown;
  durationSeconds?: unknown;
}

/**
 * This piece's most recent completed export, from the SAME jobs the
 * Background Jobs tab reads (`GET /api/jobs?kind=export`) — no new route.
 * `/api/jobs` does not filter by piece server-side, so the piece match and
 * "most recent" pick happen here, over whatever the (small, polled-only-while-
 * inflight) export job list already contains.
 */
function useLatestExport(pieceId: string): LatestExport | null {
  const jobs = useAllJobs({ kind: "export" });
  return useMemo(() => {
    const rows = jobs.data?.jobs ?? [];
    const parsed = rows
      .filter((j) => j.pieceId === pieceId && j.status === "completed" && !!j.resultJson)
      .map((j) => {
        let result: ExportJobResult;
        try {
          result = JSON.parse(j.resultJson as string) as ExportJobResult;
        } catch {
          return null;
        }
        if (typeof result.filePath !== "string" || typeof result.width !== "number" || typeof result.height !== "number") {
          return null;
        }
        const latest: LatestExport = {
          filePath: result.filePath,
          width: result.width,
          height: result.height,
          sizeBytes: typeof result.sizeBytes === "number" ? result.sizeBytes : 0,
          durationSeconds: typeof result.durationSeconds === "number" ? result.durationSeconds : 0,
        };
        return { latest, completedAt: j.completedAt };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => new Date(b.completedAt ?? 0).getTime() - new Date(a.completedAt ?? 0).getTime());
    return parsed[0]?.latest ?? null;
  }, [jobs.data, pieceId]);
}

/**
 * The piece editor's Posting tab — a filtered lens over the same social
 * components the Social page uses (`components/social/`), showing only this
 * piece's posts with inline per-target analytics, plus the composer to
 * draft/schedule/publish a new one. It is NOT a second dashboard: accounts,
 * the calendar, ads and settings stay on the Social page (linked out via
 * "See everything in Social →").
 *
 * TWO VIEWS, not one scroll. History is what a piece that has been posted is
 * for, and the composer is five steps tall — stacked, the composer pushed the
 * posts off screen and every visit re-read as "make another one". So the
 * default view is the history, and "New post" is a call to action that swaps
 * the view, with the way back always on screen. A piece with nothing posted
 * yet opens straight into the composer: an empty list is not a destination.
 */
/** The type filter's own value for an ad. Ads have no post type of their own,
 *  and the user asked for one list of everything this piece did. */
const AD_TYPE = "ad";

export function PostingTab({ pieceId }: { pieceId: string }) {
  const status = useSocialStatus();
  const piece = usePiece(pieceId);
  const posts = useSocialPiecePosts(pieceId, !!status.data?.connected);
  const ads = useSocialPieceAds(pieceId, !!status.data?.connected);
  const intent = usePostingIntent(pieceId);
  const latest = useLatestExport(pieceId);
  // Two different things, deliberately two states. `reviewing` is the detail
  // sheet (a post you clicked to read); `editing` is the post the COMPOSER is
  // open on. They were one field, which is why a draft could not have an Edit
  // button: clicking it would have opened the sheet as well.
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [view, setView] = useState<"posts" | "new">("new");
  const [platform, setPlatform] = useState<string>("");
  const [type, setType] = useState<string>("");
  // The one post (or ad) the user came here to look at, from the Social
  // page's "Piece" link. A filter like the two above, with its own way out.
  const [focus, setFocus] = useState<string | null>(intent?.focusPostId ?? null);

  // Mount-once: this tab is remounted by switching away and back, and each
  // such visit is its own "viewed" moment, not a re-render inside one visit.
  useEffect(() => {
    trackEvent("social_posting_tab_viewed");
  }, []);

  // A fresh intent (nonce bump) carrying a `providerPostId` puts the composer
  // into edit mode for that draft. Derived DURING RENDER off the previous
  // nonce — never a setState-in-effect (banned by this repo's lint rule; see
  // `export-dialog.tsx`'s `prevPieceName`/`prevDefaults` blocks for the same
  // pattern) — so there is no extra render lagging behind the intent arriving.
  const [seenNonce, setSeenNonce] = useState(intent?.nonce ?? 0);
  if ((intent?.nonce ?? 0) !== seenNonce) {
    setSeenNonce(intent?.nonce ?? 0);
    if (intent?.focusPostId) {
      // "Show me this post" — the list, narrowed to it. Never the composer.
      setFocus(intent.focusPostId);
      setView("posts");
    } else {
      if (intent?.providerPostId) setEditing(intent.providerPostId);
      // Otherwise an intent is someone ASKING to post — the export dialog's
      // "Post…", `libi.post_piece`, or reopening a draft. It goes to the
      // composer whatever the history says.
      setView("new");
    }
  }
  // A focus hand-off is read once; leaving it in the store would replay it
  // every time this tab remounts, long after the user cleared it.
  useEffect(() => {
    if (intent?.focusPostId) consumePostingIntent();
  }, [intent]);

  // Which view to open on, decided ONCE and only when the answer is knowable:
  // until the piece's posts have loaded, "has it been posted?" has no answer,
  // and guessing it would flip the view under the user a beat after they got
  // there.
  const [openingViewDecided, setOpeningViewDecided] = useState(false);
  if (!openingViewDecided && !posts.isLoading && posts.data) {
    setOpeningViewDecided(true);
    if (posts.data.length > 0 && (!intent || intent.focusPostId)) setView("posts");
  }

  const st = status.data;
  const gate: "loading" | "no-provider" | "revoked" | "never" | "ok" = !st
    ? "loading"
    : !st.providerId
      ? "no-provider"
      : st.needsReconnect
        ? "revoked"
        : !st.connected
          ? "never"
          : "ok";

  const all = useMemo(() => posts.data ?? [], [posts.data]);
  const allAds = useMemo(() => ads.data?.ads ?? [], [ads.data]);
  /** Ads that boost a post, grouped under it — that IS the relationship, so
   *  they are drawn with the post rather than in a list of their own. */
  const boostsByPost = useMemo(() => {
    const m = new Map<string, typeof allAds>();
    for (const e of allAds) {
      if (e.origin !== "boosted" || !e.boostsPostId) continue;
      m.set(e.boostsPostId, [...(m.get(e.boostsPostId) ?? []), e]);
    }
    return m;
  }, [allAds]);
  /** Ads with no post of their own — the piece went straight to an ad. */
  const standaloneAds = useMemo(() => allAds.filter((e) => e.origin === "linked" || !e.boostsPostId), [allAds]);

  const platformOptions = useMemo(() => [...new Set(all.flatMap((p) => p.targets.map((t) => t.platform)))], [all]);
  const typeOptions = useMemo(
    () => [...new Set(all.flatMap(postTypes)), ...(allAds.length > 0 ? [AD_TYPE] : [])],
    [all, allAds],
  );
  const shown = useMemo(
    () =>
      all.filter(
        (p) =>
          (!focus || p.id === focus) &&
          (!platform || p.targets.some((t) => t.platform === platform)) &&
          // Filtering to "Ad" keeps the posts that HAVE one, so a boost is
          // still shown with the post it boosts.
          (!type || (type === AD_TYPE ? boostsByPost.has(p.id) : postTypes(p).includes(type))),
      ),
    [all, platform, type, boostsByPost, focus],
  );
  const shownAds = useMemo(
    () =>
      focus
        ? standaloneAds.filter((e) => e.ad.id === focus)
        : type && type !== AD_TYPE
          ? []
          : platform
            ? []
            : standaloneAds,
    [standaloneAds, type, platform, focus],
  );
  const totalItems = all.length + standaloneAds.length;

  /** The map down the side: every card in this list, named by its network and
   *  its type — which is what tells a piece's posts apart, since the caption
   *  is usually the same on all of them. Built off the FILTERED lists, so the
   *  map always describes what is actually on screen. */
  const tz = status.data?.settings.timezone ?? null;
  const navItems = useMemo<PostNavItem[]>(
    () => [
      ...shown.map((p) => ({
        id: p.id,
        label: postEntryLabel(p),
        platform: p.targets[0]?.platform ?? "",
        status: p.status,
        when: whenLabel(p, tz),
      })),
      ...shownAds.map((e) => ({
        id: e.ad.id,
        label: adEntryLabel(e.ad),
        platform: NETWORK_GLYPH[e.ad.network] ?? e.ad.network,
      })),
    ],
    [shown, shownAds, tz],
  );

  /** Open the composer on an existing post — the draft's Edit button, and the
   *  same path `openPostingTab({ providerPostId })` takes. */
  const openComposerFor = (id: string) => {
    setEditing(id);
    setView("new");
  };

  return (
    <div data-testid="posting-tab" className="flex flex-col gap-4 p-4">
      {/* ONE header line, not two. The count used to sit on a tab row of its
          own below this title — a whole line of chrome for a tab strip with
          one tab in it, above a list that already needs every pixel it can
          get. Title, count, link, and both buttons fit on one row. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 className="text-sm font-semibold">
          Posts{totalItems > 0 ? ` (${totalItems})` : ""}{" "}
          <span className="font-normal text-muted-foreground">·</span>{" "}
          <Link href="/social?tab=posts" className="cursor-pointer text-xs font-normal text-muted-foreground hover:underline">
            See everything in Social →
          </Link>
        </h2>
        <div className="flex items-center gap-2">
          <AskAgentButton kind="post" ctx={{ pieceId, pieceName: piece.data?.name }} label="Ask the agent to post" />
          {gate === "ok" && view === "posts" && (
            <Button
              size="sm"
              data-testid="posting-view-new"
              className="cursor-pointer"
              onClick={() => {
                // "New post" always means a NEW one — leaving a draft open
                // behind this button made it silently mean "keep editing
                // that draft", which is not what it says.
                setEditing(null);
                setView("new");
              }}
            >
              + New post
            </Button>
          )}
        </div>
      </div>

      {gate === "loading" ? (
        <PostListSkeleton />
      ) : gate === "no-provider" ? (
        <p className="text-sm text-muted-foreground">
          Pick a social provider on the{" "}
          <Link href="/social" className="cursor-pointer underline">
            Social page
          </Link>{" "}
          first.
        </p>
      ) : gate !== "ok" ? (
        <ConnectLibiEmptyState variant={gate} />
      ) : (
        <>
          {view === "posts" ? (
            posts.isLoading ? (
              <PostListSkeleton />
            ) : totalItems === 0 ? (
              <div className="space-y-2 py-6 text-center">
                <p className="text-sm text-muted-foreground">Nothing posted from this piece yet.</p>
                <Button size="sm" className="cursor-pointer" onClick={() => setView("new")}>
                  Post it
                </Button>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2" data-testid="posting-filters">
                  <select
                    aria-label="Platform"
                    data-testid="posting-filter-platform"
                    className="cursor-pointer rounded-lg border border-border bg-transparent px-2 py-1 text-xs"
                    value={platform}
                    onChange={(e) => setPlatform(e.target.value)}
                  >
                    <option value="">All platforms</option>
                    {platformOptions.map((p) => (
                      <option key={p} value={p}>
                        {platformLabel(p)}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Type"
                    data-testid="posting-filter-type"
                    className="cursor-pointer rounded-lg border border-border bg-transparent px-2 py-1 text-xs"
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                  >
                    <option value="">All types</option>
                    {typeOptions.map((t) => (
                      <option key={t} value={t}>
                        {CONTENT_TYPE_LABEL[t] ?? t}
                      </option>
                    ))}
                  </select>
                  {/* Counted the same way the tab above counts: posts AND
                      ads. "10 of 10" under a tab that says "Posts (11)" was
                      two different totals for one list. */}
                  <span className="text-xs text-muted-foreground" data-testid="posting-filter-count">
                    {shown.length + shownAds.length} of {totalItems}
                  </span>
                  {focus && (
                    // Said as what it is — the list is narrowed to the post
                    // the user came from — with the one-click way back.
                    <span
                      className="inline-flex items-center gap-1.5 rounded-4xl border border-primary/40 bg-primary/10 py-0.5 pr-1 pl-2.5 text-xs text-primary"
                      data-testid="posting-focus-chip"
                    >
                      The post you opened from Social
                      <button
                        type="button"
                        data-testid="posting-focus-clear"
                        onClick={() => setFocus(null)}
                        className="cursor-pointer rounded-4xl px-1.5 hover:bg-primary/15"
                      >
                        Show all
                      </button>
                    </span>
                  )}
                </div>

                {/* The map on the left, the cards on the right — on a
                    CONTAINER query, not a viewport one. This tab lives in a
                    panel whose width is whatever the chat and resources
                    panels leave it, so a `lg:` breakpoint would keep the map
                    on screen in a 600 px panel purely because the window is
                    wide. Below that, the map is the one to drop: the cards
                    ARE the content. */}
                <div className="@container">
                <div className="grid gap-4 @xl:grid-cols-[11rem_minmax(0,1fr)]">
                  <div className="hidden @xl:block">
                    <PostNav items={navItems} />
                  </div>
                  <ul className="flex min-w-0 flex-col gap-3" data-testid="piece-posts-list">
                    {shown.map((p) => {
                      const boosts = boostsByPost.get(p.id) ?? [];
                      const hasAnalytics = p.status === "published" || p.status === "partial";
                      // Computed, not inlined: `{cond && <x/>}` still hands
                      // `children` a truthy array, and PostRow would then draw
                      // an empty divider under every draft.
                      const detail =
                        boosts.length > 0 || hasAnalytics ? (
                          <>
                            {boosts.length > 0 && (
                              <div className="space-y-2" data-testid={`piece-post-ad-${p.id}`}>
                                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                  {boosts.length === 1 ? "Boosted by 1 ad" : `Boosted by ${boosts.length} ads`}
                                </h4>
                                {boosts.map((e) => (
                                  <AdRow key={e.ad.id} entry={e} compact />
                                ))}
                              </div>
                            )}
                            {hasAnalytics && (
                              <div data-testid={`piece-post-analytics-${p.id}`}>
                                <AnalyticsPanel postId={p.id} />
                              </div>
                            )}
                          </>
                        ) : null;
                      return (
                        <PostRow
                          key={p.id}
                          post={p}
                          onOpen={setReviewing}
                          onEdit={openComposerFor}
                          showPiece={false}
                          anchorId={postAnchorId(p.id)}
                        >
                          {detail}
                        </PostRow>
                      );
                    })}
                    {shownAds.map((e) => (
                      <li
                        className="list-none"
                        key={e.ad.id}
                        id={postAnchorId(e.ad.id)}
                        data-nav-id={e.ad.id}
                        data-testid="piece-standalone-ad"
                      >
                        <AdRow entry={e} />
                      </li>
                    ))}
                  </ul>
                </div>
                </div>
                {shown.length === 0 && shownAds.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    {focus
                      ? "That post isn't on this piece any more — it may have been deleted at the provider."
                      : "Nothing from this piece matches those filters."}
                  </p>
                )}
                {/* An account with no ads tree is an ordinary state, and the
                    provider's own words for it are shown rather than a guess
                    at why. libi reads ads and never creates, pauses or funds
                    one — there is deliberately no control here that its grant
                    could not honour. */}
                {allAds.length === 0 && (
                  <p className="text-xs text-muted-foreground" data-testid="piece-ads-empty">
                    {ads.data?.unavailable[0]?.message ??
                      "No ads run this piece yet. Boost one of these posts, or have your agent create an ad — either way it shows up here."}{" "}
                    <Link href="/social?tab=ads" className="cursor-pointer underline">
                      All ads →
                    </Link>
                  </p>
                )}
              </>
            )
          ) : (
            <section className="rounded-lg border border-border p-4">
              {all.length > 0 && (
                <button
                  type="button"
                  data-testid="posting-back-to-posts"
                  onClick={() => setView("posts")}
                  className="mb-3 cursor-pointer text-xs text-muted-foreground hover:underline"
                >
                  ← Back to this piece&apos;s posts
                </button>
              )}
              <Composer
                key={`${pieceId}:${editing ?? "new"}:${intent?.nonce ?? 0}`}
                intent={{
                  pieceId,
                  pieceName: piece.data?.name ?? "Untitled",
                  exportPath: intent?.exportPath ?? latest?.filePath ?? null,
                  draftPostId: editing,
                }}
                latestExport={latest}
                onExportRequested={() => requestExportDialog(pieceId)}
                onDone={() => {
                  consumePostingIntent();
                  setEditing(null);
                  // The post exists now: the thing worth looking at is the
                  // history, not the form that made it — and not a detail
                  // sheet drawn over the top of it either.
                  setView("posts");
                }}
              />
            </section>
          )}

          <PostDetailSheet postId={reviewing} onClose={() => setReviewing(null)} />
        </>
      )}
    </div>
  );
}
