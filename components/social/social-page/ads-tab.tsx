"use client";

import { useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AskAgentButton } from "@/components/social/ask-agent-button";
import { AdStatusChip, NETWORK_GLYPH, NETWORK_LABEL, adEntryLabel, money } from "@/components/social/ad-row";
import { PlatformIcon } from "@/components/social/platform-icon";
import { PieceLink } from "@/components/social/post-links";
import { ListGridSkeleton, ListTableSkeleton } from "@/components/social/social-skeletons";
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
import { fmtCount } from "@/lib/social/format";
import { SocialApiError, useSocialAds } from "@/lib/queries/social";
import type { AdListEntry } from "@/lib/social/types";

const SELECT_CLASS = "h-8 cursor-pointer rounded-lg border border-input bg-transparent px-2 text-xs";

type AdSortKey = "date" | "spend" | "impressions" | "reach" | "clicks" | "ctr" | "cpc" | "cpm";
type MetricKey = Exclude<AdSortKey, "date">;
const METRIC_COLUMNS: Array<{ key: MetricKey; label: string }> = [
  { key: "spend", label: "Spend" },
  { key: "impressions", label: "Impr." },
  { key: "reach", label: "Reach" },
  { key: "clicks", label: "Clicks" },
  { key: "ctr", label: "CTR" },
  { key: "cpc", label: "CPC" },
  { key: "cpm", label: "CPM" },
];

const ORIGIN_LABEL: Record<AdListEntry["origin"], string> = {
  boosted: "Boosted post",
  linked: "Ad only",
  external: "Not from libi",
};

function fmtMetric(e: AdListEntry, key: MetricKey): string | null {
  const v = e.ad.metrics?.[key];
  if (v === undefined) return null;
  if (key === "spend" || key === "cpc" || key === "cpm") return money(v, e.ad.currency);
  if (key === "ctr") return `${v.toFixed(2)}%`;
  return fmtCount(v);
}

function adTime(e: AdListEntry): number | undefined {
  const t = e.ad.createdAt ? Date.parse(e.ad.createdAt) : NaN;
  return Number.isNaN(t) ? undefined : t;
}

function fmtDate(e: AdListEntry): string | null {
  const t = adTime(e);
  return t === undefined ? null : new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function searchText(e: AdListEntry): string {
  return [e.ad.name, e.ad.campaignName, NETWORK_LABEL[e.ad.network] ?? e.ad.network, e.pieceName, ORIGIN_LABEL[e.origin]]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * The same three buttons a post carries, in the same order: the network, the
 * piece, then (for a boost) the post it boosts. There is deliberately no pause,
 * resume or budget control — libi holds no ads write scope, and every ad
 * change goes through the agent (the note under the list).
 */
function AdButtons({ entry, onOpen }: { entry: AdListEntry; onOpen: (postId: string) => void }) {
  const { ad } = entry;
  const network = NETWORK_LABEL[ad.network] ?? ad.network;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {ad.previewUrl && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <a
                  href={ad.previewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open on ${network}`}
                  data-testid="ad-action-open"
                  className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-border bg-background hover:bg-muted"
                />
              }
            >
              <PlatformIcon platform={NETWORK_GLYPH[ad.network] ?? ad.network} className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>Open the ad on {network}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {entry.pieceId && (
        // A boost lands on the post it boosts — that is where its ads are
        // drawn on the Posting tab; an ad-only one lands on itself.
        <PieceLink pieceId={entry.pieceId} pieceName={entry.pieceName} focusId={entry.postId ?? ad.id} />
      )}
      {entry.postId && (
        <Button
          variant="outline"
          size="sm"
          className="cursor-pointer"
          data-testid="ad-action-post"
          onClick={() => onOpen(entry.postId!)}
        >
          <ExternalLink className="size-3.5" />
          Post
        </Button>
      )}
    </div>
  );
}

function AdKind({ entry }: { entry: AdListEntry }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
      <PlatformIcon platform={NETWORK_GLYPH[entry.ad.network] ?? entry.ad.network} className="size-3 shrink-0" />
      <span className="truncate" data-testid="ad-row-kind">
        {adEntryLabel(entry.ad)}
      </span>
    </span>
  );
}

function AdsTable({
  rows,
  sort,
  onSort,
  onOpen,
}: {
  rows: AdListEntry[];
  sort: SortState<AdSortKey> | null;
  onSort: (s: SortState<AdSortKey>) => void;
  onOpen: (postId: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border" data-testid="ads-table">
      <Table>
        <TableHeader className="bg-muted">
          <TableRow>
            <TableHead>Ad</TableHead>
            <TableHead>Status</TableHead>
            <SortHead label="Created" k="date" sort={sort} onSort={onSort} align="left" />
            {METRIC_COLUMNS.map((c) => (
              <SortHead key={c.key} label={c.label} k={c.key} sort={sort} onSort={onSort} />
            ))}
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((e) => (
            <TableRow key={e.ad.id} data-testid="ad-row" data-ad-id={e.ad.id} data-origin={e.origin}>
              <TableCell className="max-w-72">
                <div className="flex items-center gap-3">
                  <Thumb media={e.media} platform={NETWORK_GLYPH[e.ad.network] ?? e.ad.network} className="size-10 shrink-0 rounded-md" />
                  <span className="min-w-0">
                    <AdKind entry={e} />
                    <span className="block truncate text-sm font-medium">{e.ad.name || "Untitled ad"}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {ORIGIN_LABEL[e.origin]}
                      {e.ad.campaignName ? ` · ${e.ad.campaignName}` : ""}
                    </span>
                  </span>
                </div>
              </TableCell>
              <TableCell>
                <AdStatusChip status={e.ad.status} />
              </TableCell>
              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{fmtDate(e) ?? "—"}</TableCell>
              {METRIC_COLUMNS.map((c) => {
                const v = fmtMetric(e, c.key);
                return (
                  <TableCell key={c.key} className="text-right tabular-nums" data-testid={`ad-metric-${c.key}`}>
                    {/* Absent is absent — the ad shapes are still unverified
                        against a live account, so a missing field must never
                        read as a zero someone could act on. */}
                    {v ?? <span className="text-muted-foreground/50">—</span>}
                  </TableCell>
                );
              })}
              <TableCell>
                <div className="flex justify-end">
                  <AdButtons entry={e} onOpen={onOpen} />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function AdsGrid({ rows, onOpen }: { rows: AdListEntry[]; onOpen: (postId: string) => void }) {
  return (
    <div className="@container">
      <ul className="grid grid-cols-2 gap-4 @2xl:grid-cols-3" data-testid="ads-grid">
        {rows.map((e) => {
          const date = fmtDate(e);
          const spend = fmtMetric(e, "spend");
          const impressions = fmtMetric(e, "impressions");
          const ctr = fmtMetric(e, "ctr");
          return (
            <li
              key={e.ad.id}
              data-testid="ad-row"
              data-ad-id={e.ad.id}
              data-origin={e.origin}
              className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm"
            >
              <div className="relative">
                <Thumb media={e.media} platform={NETWORK_GLYPH[e.ad.network] ?? e.ad.network} className="aspect-square w-full" />
                <span className="absolute top-2 left-2">
                  <AdStatusChip status={e.ad.status} />
                </span>
              </div>
              <div className="flex flex-1 flex-col gap-2 p-3">
                <div className="flex min-w-0 items-center gap-2">
                  <AdKind entry={e} />
                  {date && <span className="ml-auto shrink-0 text-[0.7rem] text-muted-foreground">{date}</span>}
                </div>
                <p className="line-clamp-2 text-sm font-medium">{e.ad.name || "Untitled ad"}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {ORIGIN_LABEL[e.origin]}
                  {e.ad.campaignName ? ` · ${e.ad.campaignName}` : ""}
                </p>
                {(spend || impressions || ctr) && (
                  <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums" data-testid="ad-grid-metrics">
                    {spend && <span>{spend} spent</span>}
                    {impressions && <span>{impressions} impr.</span>}
                    {ctr && <span>{ctr} CTR</span>}
                  </p>
                )}
                <div className="mt-auto pt-1">
                  <AdButtons entry={e} onOpen={onOpen} />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Reporting only — every branch of this component reads, never writes.
 * There is no ads write route anywhere in the feature: pausing, resuming or
 * creating an ad goes through the user's own agent (`AskAgentButton`), never
 * libi's UI, because libi never requested an ads write scope.
 *
 * Laid out like the Posts tab on purpose — the same toolbar, the same two
 * views and the same buttons — so the two lists read as one product with
 * different numbers in it (QA 2026-09-22).
 */
export function AdsTab({ onOpen }: { onOpen: (postId: string) => void }) {
  const ads = useSocialAds();
  const [view, setView] = useListView("ads");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [network, setNetwork] = useState("");
  const [accountId, setAccountId] = useState("");
  const [campaign, setCampaign] = useState("");
  const [fromLibi, setFromLibi] = useState(false);
  const [sort, setSort] = useState<SortState<AdSortKey> | null>(null);

  const entries = useMemo(() => ads.data?.ads ?? [], [ads.data]);
  const accounts = ads.data?.accounts ?? [];
  const statusOptions = useMemo(() => [...new Set(entries.map((e) => e.ad.status.toLowerCase()))], [entries]);
  const networkOptions = useMemo(() => [...new Set(entries.map((e) => e.ad.network))], [entries]);
  const campaignOptions = useMemo(
    () => [...new Set(entries.map((e) => e.ad.campaignName).filter((c): c is string => !!c))],
    [entries],
  );
  const needle = query.trim().toLowerCase();
  const rows = entries.filter(
    (e) =>
      (statusFilter.length === 0 || statusFilter.includes(e.ad.status.toLowerCase())) &&
      (!network || e.ad.network === network) &&
      (!accountId || e.ad.adAccountId === accountId) &&
      (!campaign || e.ad.campaignName === campaign) &&
      (!fromLibi || !!e.pieceId) &&
      (!needle || searchText(e).includes(needle)),
  );
  const sorted = !sort
    ? rows
    : sortRows(rows, sort.dir, (e) => (sort.key === "date" ? adTime(e) : e.ad.metrics?.[sort.key]));

  if (ads.isLoading) return view === "table" ? <ListTableSkeleton /> : <ListGridSkeleton />;

  // A read failure that ISN'T a 429 (that's `RateLimitBanner`'s job) is not
  // "no ad accounts" — one connected account's ads tree can fail to parse
  // (observed live: `ad_accounts_list_ad_accounts answered in a format libi
  // cannot read`) and crash the whole read rather than degrading into
  // `unavailable` the way a validation error does. Saying so here, with a
  // retry, beats silently rendering the empty state as if nothing were
  // connected.
  const hardError = ads.error instanceof SocialApiError && ads.error.status !== 429 ? ads.error : null;
  if (hardError && !ads.data) {
    return (
      <div className="space-y-3 pt-4">
        <p className="text-sm text-muted-foreground" data-testid="ads-error">
          Couldn&apos;t read ads from Zernio right now.
        </p>
        <Button variant="outline" size="sm" className="cursor-pointer" onClick={() => void ads.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const unavailable = ads.data?.unavailable ?? [];
  const toggleStatus = (s: string) => setStatusFilter((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  return (
    <div className="space-y-3 pt-4">
      <RateLimitBanner error={ads.error} />

      {/* Shown whenever `unavailable` is non-empty — even alongside real
          ads, never only when the list is empty (an Instagram account with
          no linked Facebook has no ads tree while a TikTok account right
          next to it does). */}
      {unavailable.length > 0 && (
        <div data-testid="ads-unavailable" className="space-y-1.5 rounded-lg border border-border bg-muted/30 p-3 text-sm">
          <p>
            Zernio hasn&apos;t exposed ads for this account yet — connect an ad account at{" "}
            <a
              href="https://zernio.com/dashboard"
              target="_blank"
              rel="noopener noreferrer"
              className="cursor-pointer text-primary hover:underline"
            >
              Zernio ↗
            </a>
          </p>
          {/* One row per account (`mergeUnavailable` guarantees it), so
              `accountId` is a unique key. */}
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
            {unavailable.map((u) => (
              <li key={u.accountId}>{u.message}</li>
            ))}
          </ul>
        </div>
      )}

      {entries.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2" data-testid="ads-toolbar">
            <SearchBox value={query} onChange={setQuery} placeholder="Search ads, campaigns, pieces…" />
            {networkOptions.length > 1 && (
              <select aria-label="Network" className={SELECT_CLASS} value={network} onChange={(e) => setNetwork(e.target.value)}>
                <option value="">All networks</option>
                {networkOptions.map((n) => (
                  <option key={n} value={n}>
                    {NETWORK_LABEL[n] ?? n}
                  </option>
                ))}
              </select>
            )}
            {accounts.length > 0 && (
              <select aria-label="Ad account" className={SELECT_CLASS} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">All ad accounts</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
            {campaignOptions.length > 0 && (
              <select aria-label="Campaign" className={SELECT_CLASS} value={campaign} onChange={(e) => setCampaign(e.target.value)}>
                <option value="">All campaigns</option>
                {campaignOptions.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
            <div className="ml-auto">
              <ViewToggle value={view} onChange={setView} />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2" data-testid="ads-filter-bar">
            {statusOptions.map((s) => (
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
              <input type="checkbox" className="cursor-pointer" checked={fromLibi} onChange={(e) => setFromLibi(e.target.checked)} />
              From a libi piece
            </label>
          </div>

          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No ads match these filters.</p>
          ) : view === "table" ? (
            <AdsTable rows={sorted} sort={sort} onSort={setSort} onOpen={onOpen} />
          ) : (
            <AdsGrid rows={sorted} onOpen={onOpen} />
          )}
        </>
      )}

      {entries.length === 0 && unavailable.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="ads-empty">
          {accounts.length > 0 ? "No ads on your connected ad accounts yet." : "No ad accounts connected yet."}
        </p>
      )}

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        <p>Every ad change, including pausing, goes through your agent, which will state the budget and wait for your yes.</p>
        <AskAgentButton kind="ads" ctx={{}} label="Ask the agent to create an ad…" />
      </div>
    </div>
  );
}
