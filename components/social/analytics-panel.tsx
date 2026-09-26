"use client";

import { RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AskAgentButton } from "@/components/social/ask-agent-button";
import { useSocialAccounts, useSocialPostAnalytics } from "@/lib/queries/social";
import { fmtCount } from "@/lib/social/format";
import { platformLabel } from "@/lib/social/catalog";
import type { PostAnalytics, StoryInsights } from "@/lib/social/types";
import { PlatformIcon } from "@/components/social/platform-icon";

type MetricKey = Exclude<keyof PostAnalytics["perTarget"][number], "platform" | "extras">;

const METRIC_ROWS: Array<{ key: MetricKey; label: string }> = [
  { key: "views", label: "Views" },
  { key: "reach", label: "Reach" },
  { key: "impressions", label: "Impressions" },
  { key: "likes", label: "Likes" },
  { key: "comments", label: "Comments" },
  { key: "shares", label: "Shares" },
  { key: "saves", label: "Saves" },
  { key: "engagementRate", label: "Engagement rate" },
];


function fmtMetric(key: string, v?: number): string {
  if (v === undefined) return "—";
  if (key === "engagementRate") return `${v.toFixed(1)}%`;
  return fmtCount(v);
}

function fmtLastUpdated(s?: string): string | null {
  if (!s) return null;
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

const STORY_ROWS: Array<{ key: keyof StoryInsights["metrics"]; label: string }> = [
  { key: "views", label: "Views" },
  { key: "reach", label: "Reach" },
  { key: "replies", label: "Replies" },
  { key: "shares", label: "Shares" },
  { key: "profileVisits", label: "Profile visits" },
  { key: "follows", label: "Follows" },
  { key: "tapsForward", label: "Taps forward" },
  { key: "tapsBack", label: "Taps back" },
  { key: "exits", label: "Exits" },
  { key: "navigation", label: "Navigation" },
  { key: "totalInteractions", label: "Total interactions" },
];

const STORY_SOURCE_NOTE: Record<StoryInsights["source"], string> = {
  live: "This Story is still up — these are its numbers right now.",
  cached: "This Story has expired; these are its final numbers.",
  unavailable: "This Story expired before its final numbers reached Zernio, so there is nothing to show. Nothing further will arrive.",
};

/**
 * One Instagram Story's own metrics. A Story never appears in post analytics
 * at all (see the analytics route) — which is why this is a separate block
 * rather than another column in the table above, and why its rows are
 * different metrics: a Story has taps and exits, not saves.
 */
function StoryBlock({ username, insights }: { username?: string; insights: StoryInsights }) {
  return (
    <div data-testid="story-insights" data-source={insights.source} className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <PlatformIcon platform="instagram" className="size-3.5" />
        Instagram Story{username ? ` · @${username}` : ""}
      </div>
      {insights.source === "unavailable" ? (
        <p className="text-sm text-muted-foreground">{STORY_SOURCE_NOTE.unavailable}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
            {STORY_ROWS.map((r) => (
              <div key={r.key} className="flex items-baseline justify-between gap-2 text-sm">
                <span className="text-muted-foreground">{r.label}</span>
                <span data-testid={`story-metric-${r.key}`} className="tabular-nums">
                  {fmtMetric(r.key, insights.metrics[r.key])}
                </span>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {STORY_SOURCE_NOTE[insights.source]} Instagram reports any count below 5 as 0 on a small audience, so a 0 here
            can mean &ldquo;a few&rdquo;.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * The analytics block's own header: what it is on the left, what you can do
 * to it on the right, as icons.
 *
 * These two controls used to be full-width buttons at the BOTTOM of every
 * post's analytics — two more rows of chrome per post in a list of ten, which
 * is what made the Posting tab hard to read (QA 2026-09-21). They are the
 * same two actions; they just no longer cost a line each.
 */
function AnalyticsHeader({ postId, onRefresh, refreshing }: { postId: string; onRefresh?: () => void; refreshing?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Analytics</h4>
      {onRefresh && (
        <div className="flex items-center gap-0.5">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="cursor-pointer text-muted-foreground hover:text-foreground"
                    data-testid="analytics-refresh"
                    aria-label="Refresh analytics"
                    disabled={refreshing}
                    onClick={onRefresh}
                  />
                }
              >
                <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
              </TooltipTrigger>
              <TooltipContent>Refresh analytics</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <AskAgentButton kind="analytics" ctx={{ postId }} label="Ask the agent what this means" icon={Sparkles} />
        </div>
      )}
    </div>
  );
}

/** "Still syncing" is signalled by `syncStatus`, never rendered as zeros — a
 *  provider that hasn't finished a sync answers with real fields missing,
 *  which would otherwise look like a post with no engagement at all. */
export function AnalyticsPanel({ postId }: { postId: string }) {
  const q = useSocialPostAnalytics(postId);
  const accounts = useSocialAccounts();
  const usernameFor = (id: string) => accounts.data?.find((a) => a.id === id)?.username;

  if (q.isLoading) {
    return (
      <div data-testid="analytics-panel" className="space-y-2">
        <AnalyticsHeader postId={postId} />
        <p className="text-sm text-muted-foreground">Reading analytics from Zernio…</p>
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      </div>
    );
  }

  const data = q.data;
  const stories = data?.stories ?? [];

  // A Story's numbers arrive through Instagram's own story-insights endpoint,
  // never through post analytics — so a post whose only target is a Story is
  // FINISHED here even though `syncStatus` says "pending", and will say so
  // forever. Rendering the old "check back in a few minutes" over the top of
  // numbers we already hold was the bug: the message could never come true.
  // A row with no metric on it at all is the provider saying nothing, not a
  // post with zeros. When a Story is the only target that row is permanently
  // empty (its numbers are in `stories`), and a table of em-dashes beside the
  // real figures reads as missing data rather than as a different endpoint.
  const perTarget = (data?.perTarget ?? []).filter((t) => METRIC_ROWS.some((r) => t[r.key] !== undefined));
  if (!data || (data.syncStatus !== "ready" && stories.length === 0)) {
    const message =
      data?.syncStatus === "failed"
        ? "Analytics couldn't be read from Zernio right now."
        : "Analytics are syncing at Zernio — check back in a few minutes";
    return (
      <div data-testid="analytics-panel" className="space-y-2">
        <AnalyticsHeader postId={postId} onRefresh={() => void q.refetch()} refreshing={q.isFetching} />
        <p className="text-sm text-muted-foreground">{message}</p>
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      </div>
    );
  }

  const lastUpdated = fmtLastUpdated(data.lastUpdated);

  return (
    <div data-testid="analytics-panel" className="space-y-2">
      <AnalyticsHeader postId={postId} onRefresh={() => void q.refetch()} refreshing={q.isFetching} />
      {stories.map((s) => (
        <StoryBlock key={s.platformPostId} username={usernameFor(s.accountId)} insights={s.insights} />
      ))}
      {perTarget.length > 0 && (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Metric</TableHead>
            {perTarget.map((t) => (
              <TableHead key={t.platform}>{platformLabel(t.platform)}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {METRIC_ROWS.map((row) => (
            <TableRow key={row.key}>
              <TableCell className="text-muted-foreground">{row.label}</TableCell>
              {perTarget.map((t) => (
                <TableCell key={t.platform}>{fmtMetric(row.key, t[row.key])}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      )}
      <p className="text-xs text-muted-foreground">
        {/* The 24 h lag is Instagram's, and this line used to say so under a
            TikTok, X or YouTube table — a caveat about the wrong platform is
            worse than none. */}
        {perTarget.some((t) => t.platform === "instagram") ? "Instagram reach and impressions lag about 24 h. " : ""}
        Metrics stay on the provider; libi keeps none.
        {lastUpdated ? ` Last updated ${lastUpdated}.` : ""}
      </p>
    </div>
  );
}
