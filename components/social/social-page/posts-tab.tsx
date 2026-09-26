"use client";

import { useMemo, useState } from "react";
import { SlidersHorizontal, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AskAgentButton } from "@/components/social/ask-agent-button";
import { PlatformIcon } from "@/components/social/platform-icon";
import { PostActions } from "@/components/social/post-actions";
import { PieceLink, PlatformOpenLinks } from "@/components/social/post-links";
import { ListGridSkeleton, ListTableSkeleton } from "@/components/social/social-skeletons";
import { StatusChip, TargetChips } from "@/components/social/status-chips";
import { RateLimitBanner } from "@/components/social/social-page/social-page";
import {
  SearchBox,
  SortHead,
  Thumb,
  ViewToggle,
  sortRows,
  useListView,
  type SortState,
} from "@/components/social/social-page/list-views";
import {
  type LinkedPost,
  useRetrySocialPost,
  useSocialAccounts,
  useSocialPosts,
  useSocialPostsAnalytics,
  useSocialStatus,
} from "@/lib/queries/social";
import { platformLabel } from "@/lib/social/catalog";
import type { KnownPlatform } from "@/lib/social/catalog";
import {
  captionFirstLine,
  fmtCount,
  isStoryOnly,
  postEntryLabel,
  summarizeAnalytics,
  whenLabel,
  type PostMetricSummary,
} from "@/lib/social/format";
import type { PostStatus } from "@/lib/social/types";

const STATUS_OPTIONS: PostStatus[] = ["draft", "scheduled", "publishing", "published", "partial", "failed", "cancelled"];
const SELECT_CLASS = "h-8 cursor-pointer rounded-lg border border-input bg-transparent px-2 text-xs";

type PostSortKey = "date" | "views" | "reach" | "likes" | "comments" | "shares";
const METRIC_COLUMNS: Array<{ key: Exclude<PostSortKey, "date">; label: string }> = [
  { key: "views", label: "Views" },
  { key: "reach", label: "Reach" },
  { key: "likes", label: "Likes" },
  { key: "comments", label: "Comments" },
  { key: "shares", label: "Shares" },
];

/** Only a post that is out there has numbers; asking for a draft's would
 *  spend a provider request (60/min on the free plan) to learn nothing. */
const hasAnalytics = (p: LinkedPost) => p.status === "published" || p.status === "partial";

/** The moment that best describes the post: when it went out, else when it
 *  will, else when it was made. */
function postTime(p: LinkedPost): number | undefined {
  const t = Date.parse(p.publishedAt ?? p.scheduledFor ?? p.createdAt);
  return Number.isNaN(t) ? undefined : t;
}

/** The table's date: short enough to leave the numbers room. The grid and
 *  the detail sheet keep the full `whenLabel`. */
function shortWhen(p: LinkedPost, tz: string | null): string {
  const t = postTime(p);
  if (t === undefined) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: tz ?? undefined }).format(t);
}

function pieceOf(p: LinkedPost): { id: string; name?: string } | null {
  const id = p.link?.pieceId ?? p.libi?.pieceId;
  return id ? { id, name: p.libi?.pieceName } : null;
}

/** What the search box matches: the words on the card, the network, the type
 *  and the piece — what someone looking for "that TikTok about the desk"
 *  would type. */
function searchText(p: LinkedPost): string {
  return [p.content, p.title, postEntryLabel(p), p.libi?.pieceName, ...p.targets.map((t) => platformLabel(t.platform))]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * The empty list's copy, honest about what it cannot show: a post made
 * directly at Zernio never appears in its post list (Zernio marks it
 * `isExternal` and leaves it out, analytics and all), so an empty list is not
 * proof the user has never posted. `externalCount` is the sum of every
 * account's `externalPostCount`; `null` while the accounts read is in flight.
 */
export function postsEmptyCopy(externalCount: number | null): string {
  const lead =
    externalCount === null || externalCount === 0
      ? "No posts made through libi yet."
      : externalCount === 1
        ? "No posts made through libi yet, but Zernio shows 1 post made directly there."
        : `No posts made through libi yet, but Zernio shows ${externalCount} posts made directly there.`;
  return `${lead} A post made directly at Zernio won't show up in this list — open Zernio's dashboard to see it, or ask the agent for analytics.`;
}

/** The buttons every post carries in both views, in one order: where it lives
 *  on each network, where it was made, then whatever its status allows. */
function PostButtons({ post }: { post: LinkedPost }) {
  const piece = pieceOf(post);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <PlatformOpenLinks targets={post.targets} />
      {piece && <PieceLink pieceId={piece.id} pieceName={piece.name} focusId={post.id} />}
      <PostActions post={post} compact hideOpen />
    </div>
  );
}

/** Statuses with something to DO beyond opening the post. */
const MANAGEABLE: ReadonlySet<PostStatus> = new Set(["draft", "scheduled", "failed", "partial", "cancelled"]);

/**
 * The table's version: the same links, but the lifecycle (schedule, publish,
 * retry, delete) behind one "Manage" that opens the post's sheet, which has
 * all of it. Inline, a draft's four buttons made its row four lines tall or
 * pushed the table off the page — and this view is for reading numbers.
 */
function TableButtons({ post, onOpen }: { post: LinkedPost; onOpen: (id: string) => void }) {
  const piece = pieceOf(post);
  return (
    <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
      <PlatformOpenLinks targets={post.targets} />
      {piece && <PieceLink pieceId={piece.id} pieceName={piece.name} focusId={post.id} />}
      {MANAGEABLE.has(post.status) && (
        <Button
          variant="outline"
          size="sm"
          className="cursor-pointer"
          data-testid="post-action-manage"
          title="Schedule, publish, retry or delete"
          onClick={() => onOpen(post.id)}
        >
          <SlidersHorizontal className="size-3.5" />
          Manage
        </Button>
      )}
    </div>
  );
}

function Caption({ post, className }: { post: LinkedPost; className: string }) {
  const text = captionFirstLine(post.content);
  if (isStoryOnly(post)) return <span className={`${className} italic text-muted-foreground`}>Story — no caption</span>;
  if (!text) return <span className={`${className} italic text-muted-foreground`}>No caption yet</span>;
  return <span className={className}>{text}</span>;
}

function metricCell(m: PostMetricSummary, key: keyof PostMetricSummary, post: LinkedPost, loading: boolean) {
  if (!hasAnalytics(post)) return <span className="text-muted-foreground/50">—</span>;
  if (loading) return <span className="text-muted-foreground">…</span>;
  return m[key] === undefined ? <span className="text-muted-foreground/50">—</span> : fmtCount(m[key]);
}

function PostsTable({
  rows,
  metrics,
  loadingIds,
  sort,
  onSort,
  onOpen,
  tz,
}: {
  rows: LinkedPost[];
  metrics: Map<string, PostMetricSummary>;
  loadingIds: Set<string>;
  sort: SortState<PostSortKey> | null;
  onSort: (s: SortState<PostSortKey>) => void;
  onOpen: (id: string) => void;
  tz: string | null;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border" data-testid="posts-table">
      <Table>
        <TableHeader className="bg-muted">
          <TableRow>
            <TableHead>Post</TableHead>
            <TableHead>Status</TableHead>
            <SortHead label="Date" k="date" sort={sort} onSort={onSort} align="left" />
            {METRIC_COLUMNS.map((c) => (
              <SortHead key={c.key} label={c.label} k={c.key} sort={sort} onSort={onSort} />
            ))}
            <TableHead className="text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((p) => {
            const m = metrics.get(p.id) ?? {};
            return (
              <TableRow key={p.id} data-testid="post-row" data-post-id={p.id}>
                <TableCell className="max-w-64 min-w-48">
                  <button type="button" onClick={() => onOpen(p.id)} className="flex w-full cursor-pointer items-center gap-3 text-left">
                    <Thumb media={p.media[0]} platform={p.targets[0]?.platform} className="size-10 shrink-0 rounded-md" />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
                        <PlatformIcon platform={p.targets[0]?.platform ?? ""} className="size-3 shrink-0" />
                        <span className="truncate" data-testid="post-row-kind">
                          {postEntryLabel(p)}
                        </span>
                      </span>
                      <Caption post={p} className="block truncate text-sm hover:underline" />
                    </span>
                  </button>
                </TableCell>
                <TableCell>
                  <StatusChip status={p.status} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{whenLabel(p, tz) ? shortWhen(p, tz) : "—"}</TableCell>
                {METRIC_COLUMNS.map((c) => (
                  <TableCell key={c.key} className="text-right tabular-nums" data-testid={`metric-${c.key}`}>
                    {metricCell(m, c.key, p, loadingIds.has(p.id))}
                  </TableCell>
                ))}
                <TableCell>
                  <TableButtons post={p} onOpen={onOpen} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function PostsGrid({
  rows,
  metrics,
  onOpen,
  tz,
}: {
  rows: LinkedPost[];
  metrics: Map<string, PostMetricSummary>;
  onOpen: (id: string) => void;
  tz: string | null;
}) {
  return (
    // A container query, not a viewport one: the page sits beside the app
    // sidebar, so "a wide window" says little about how wide this list is.
    <div className="@container">
      <ul className="grid grid-cols-2 gap-4 @2xl:grid-cols-3" data-testid="posts-grid">
        {rows.map((p) => {
          const m = metrics.get(p.id) ?? {};
          const when = whenLabel(p, tz);
          return (
            <li
              key={p.id}
              data-testid="post-row"
              data-post-id={p.id}
              className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm"
            >
              <button type="button" onClick={() => onOpen(p.id)} aria-label="Open post" className="relative block cursor-pointer">
                <Thumb media={p.media[0]} platform={p.targets[0]?.platform} className="aspect-square w-full" />
                {/* The status, ONCE, where the eye lands first. It used to be
                    on the card twice — a status chip and a per-network chip
                    both saying "Published" (QA 2026-09-22). */}
                <span className="absolute top-2 left-2">
                  <StatusChip status={p.status} />
                </span>
              </button>
              <div className="flex flex-1 flex-col gap-2 p-3">
                <div className="flex min-w-0 items-center gap-1.5 text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
                  <PlatformIcon platform={p.targets[0]?.platform ?? ""} className="size-3 shrink-0" />
                  <span className="truncate" data-testid="post-row-kind">
                    {postEntryLabel(p)}
                  </span>
                  {when && <span className="ml-auto shrink-0 font-normal normal-case tracking-normal">{when}</span>}
                </div>
                <button type="button" onClick={() => onOpen(p.id)} className="cursor-pointer text-left">
                  <Caption post={p} className="line-clamp-2 text-sm hover:underline" />
                </button>
                {/* Per-network chips only when the networks DISAGREE — on a
                    post that went out everywhere they only repeat the status. */}
                {(p.status === "partial" || p.status === "failed") && <TargetChips targets={p.targets} />}
                {hasAnalytics(p) && (
                  <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums" data-testid="post-grid-metrics">
                    <span>{fmtCount(m.views)} views</span>
                    <span>{fmtCount(m.likes)} likes</span>
                    <span>{fmtCount(m.comments)} comments</span>
                  </p>
                )}
                <div className="mt-auto pt-1">
                  <PostButtons post={p} />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function PostsTab({ onOpen }: { onOpen: (id: string) => void }) {
  const [statusFilter, setStatusFilter] = useState<PostStatus[]>([]);
  const [platform, setPlatform] = useState<KnownPlatform | undefined>(undefined);
  const [accountId, setAccountId] = useState<string | undefined>(undefined);
  // "made in libi" = the post has a local piece↔post link OR the provider
  // still echoes its `metadata.libi` stamp — either is proof libi made it.
  const [madeInLibi, setMadeInLibi] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [view, setView] = useListView("posts");
  const [sort, setSort] = useState<SortState<PostSortKey> | null>(null);

  const status = useSocialStatus();
  const tz = status.data?.settings.timezone ?? null;
  const accounts = useSocialAccounts();
  /**
   * The platforms this user actually has, not a fixed pair: the agent can
   * connect Facebook, X or YouTube at the provider and post there, and those
   * posts are in this list — a filter that cannot name them would be a filter
   * that hides them.
   */
  const platformOptions = useMemo(
    () => [...new Set((accounts.data ?? []).map((a) => a.platform))],
    [accounts.data],
  );
  const retry = useRetrySocialPost();

  const filter = useMemo(
    () => ({
      status: statusFilter.length ? statusFilter : undefined,
      platform,
      accountId,
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined,
      page,
      limit: 20,
    }),
    [statusFilter, platform, accountId, from, to, page],
  );
  const posts = useSocialPosts(filter);
  const allPosts = useMemo(() => posts.data?.posts ?? [], [posts.data]);
  const needle = query.trim().toLowerCase();
  const rows = useMemo(
    () =>
      allPosts.filter(
        (p) => (!madeInLibi || !!p.link || !!p.libi) && (!needle || searchText(p).includes(needle)),
      ),
    [allPosts, madeInLibi, needle],
  );
  const failedRows = rows.filter((p) => p.status === "failed");

  // Fetched for the LIST, not per row: sorting by a number needs every row's
  // number in one place. Shared cache keys with the detail sheet.
  const analytics = useSocialPostsAnalytics(useMemo(() => rows.filter(hasAnalytics).map((p) => p.id), [rows]));
  const metrics = new Map<string, PostMetricSummary>();
  const loadingIds = new Set<string>();
  for (const [id, a] of analytics) {
    metrics.set(id, summarizeAnalytics(a.data));
    if (a.isLoading) loadingIds.add(id);
  }

  const sorted = !sort
    ? rows
    : sortRows(rows, sort.dir, (p) => (sort.key === "date" ? postTime(p) : metrics.get(p.id)?.[sort.key]));

  const resetPage = () => setPage(1);
  const toggleStatus = (s: PostStatus) => {
    resetPage();
    setStatusFilter((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };
  const anyFilter = statusFilter.length > 0 || !!platform || !!accountId || madeInLibi || !!from || !!to || !!needle;
  const externalPostCount = accounts.data?.reduce((sum, a) => sum + (a.externalPostCount ?? 0), 0) ?? null;

  return (
    <div className="space-y-3 pt-4">
      <RateLimitBanner error={posts.error} />

      <div className="flex flex-wrap items-center gap-2" data-testid="posts-toolbar">
        <SearchBox value={query} onChange={setQuery} placeholder="Search captions, networks, pieces…" />
        <select
          aria-label="Platform"
          className={SELECT_CLASS}
          value={platform ?? ""}
          onChange={(e) => {
            resetPage();
            setPlatform((e.target.value || undefined) as KnownPlatform | undefined);
          }}
        >
          <option value="">All platforms</option>
          {platformOptions.map((p) => (
            <option key={p} value={p}>
              {platformLabel(p)}
            </option>
          ))}
        </select>
        <select
          aria-label="Account"
          className={SELECT_CLASS}
          value={accountId ?? ""}
          onChange={(e) => {
            resetPage();
            setAccountId(e.target.value || undefined);
          }}
        >
          <option value="">All accounts</option>
          {accounts.data?.map((a) => (
            <option key={a.id} value={a.id}>
              @{a.username}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-1">
          <AskAgentButton kind="analytics" ctx={{}} label="Ask the agent how these are doing" icon={Sparkles} />
          <ViewToggle value={view} onChange={setView} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2" data-testid="posts-filter-bar">
        {STATUS_OPTIONS.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={statusFilter.includes(s)}
            onClick={() => toggleStatus(s)}
            className={`cursor-pointer rounded-4xl border px-2.5 py-1 text-xs capitalize ${
              statusFilter.includes(s) ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"
            }`}
          >
            {s}
          </button>
        ))}
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" className="cursor-pointer" checked={madeInLibi} onChange={(e) => setMadeInLibi(e.target.checked)} />
          Made in libi
        </label>
        <Input
          type="date"
          aria-label="From"
          value={from}
          onChange={(e) => {
            resetPage();
            setFrom(e.target.value);
          }}
          className="h-8 w-auto text-xs"
        />
        <Input
          type="date"
          aria-label="To"
          value={to}
          onChange={(e) => {
            resetPage();
            setTo(e.target.value);
          }}
          className="h-8 w-auto text-xs"
        />
      </div>

      {posts.isLoading ? (
        view === "table" ? (
          <ListTableSkeleton />
        ) : (
          <ListGridSkeleton />
        )
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="posts-empty">
          {anyFilter ? "No posts match these filters." : postsEmptyCopy(externalPostCount)}
        </p>
      ) : view === "table" ? (
        <PostsTable rows={sorted} metrics={metrics} loadingIds={loadingIds} sort={sort} onSort={setSort} onOpen={onOpen} tz={tz} />
      ) : (
        <PostsGrid rows={sorted} metrics={metrics} onOpen={onOpen} tz={tz} />
      )}

      <div className="flex items-center justify-between gap-3">
        {/* Zernio has no bulk-retry tool the UI can call directly
            (`posts_retry_all_failed` is agent-side) — this loops the same
            single-post retry mutation the row action uses. */}
        {failedRows.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="cursor-pointer"
            disabled={retry.isPending}
            onClick={() => failedRows.forEach((p) => retry.mutate(p.id))}
          >
            Retry all failed
          </Button>
        )}
        {posts.data && posts.data.totalPages > 1 && (
          <div className="ml-auto flex items-center gap-2">
            {/* Said out loud, because a sorted column reads as "the top posts
                of all time" otherwise — the provider pages its list, and the
                numbers are fetched per page. */}
            {sort && <span className="text-xs text-muted-foreground">Sorted within this page</span>}
            <Button variant="outline" size="sm" className="cursor-pointer" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <span className="text-xs text-muted-foreground">
              Page {posts.data.page} of {posts.data.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="cursor-pointer"
              disabled={page >= posts.data.totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
