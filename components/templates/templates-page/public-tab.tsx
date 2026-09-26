"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { BusyLabel, BUSY_BUTTON_CLASS } from "@/components/agents-page/agents-tab/steps/busy-label";
import { PublicTemplateCard, publicTemplatePageHref, type PublicTemplate } from "@/components/templates/templates-page/public-template-card";
import { mediaUrl, templatePageHref } from "@/components/templates/templates-page/template-card";
import { PublicTemplatesTable } from "@/components/templates/templates-page/public-templates-table";
import { TemplatesGridSkeleton, TemplatesTableSkeleton, TemplatesViewPendingSkeleton } from "@/components/templates/templates-page/templates-skeletons";
import type { TemplatesView } from "@/components/templates/templates-page/use-templates-page-params";
import { ViewSwitch } from "@/components/templates/templates-page/view-switch";
import { TemplatesToolbar, topTags } from "@/components/templates/templates-page/templates-toolbar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCatalogIndex, useRefreshCatalog, useTemplateSearch, useTemplates } from "@/lib/queries/templates";
import { useCloudMine } from "@/lib/queries/templates-cloud";
import { ownCatalogView, type JustListedTemplate } from "@/lib/templates/own-catalog-view";
import type { CatalogIndexResponse, TemplateOrder, TemplateSummary } from "@/lib/templates/types";
import { formatRelativeTime } from "@/lib/utils/format";

/**
 * Readable copy for the catalog route's `error` — a fixed code
 * (lib/templates/cloud/catalog-cache.ts#CATALOG_ERROR_CODES), never shown raw.
 */
const CATALOG_ERROR_COPY: Record<string, string> = {
  unreachable: "Can't reach the catalog right now",
  http_error: "The catalog isn't answering properly right now",
  invalid_index: "The catalog sent a list libi couldn't read",
  internal: "libi couldn't update its copy of the catalog",
};

export function catalogErrorCopy(code: string): string {
  return CATALOG_ERROR_COPY[code] ?? "Couldn't refresh the catalog";
}

function publicOnly(rows: TemplateSummary[] | undefined): PublicTemplate[] {
  return (rows ?? []).filter((t): t is PublicTemplate => t.cloudId !== null);
}

/**
 * Where the cached copy stands, said plainly: fresh as of when, or why it
 * could not be refreshed and how old the copy on screen is — with the Refresh
 * that forces a fetch past the failure backoff.
 */
function CatalogStatus({
  catalog,
  failed,
  onRefresh,
  refreshing,
}: {
  catalog: CatalogIndexResponse | undefined;
  /** libi's own catalog route didn't answer (the cached list may still be on screen). */
  failed: boolean;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  if (!catalog && !failed) return <Skeleton className="mb-3 h-7 w-64" data-testid="public-status-skeleton" />;
  const error = catalog?.error;
  let text: string;
  if (!catalog) {
    text = "Couldn't check the catalog for updates — showing libi's last copy.";
  } else if (error) {
    text = catalog.fetchedAt
      ? `${catalogErrorCopy(error)} — showing the copy from ${formatRelativeTime(catalog.fetchedAt)}.`
      : `${catalogErrorCopy(error)}.`;
  } else {
    text = catalog.fetchedAt ? `Catalog updated ${formatRelativeTime(catalog.fetchedAt)}.` : "The catalog hasn't been fetched yet.";
  }
  return (
    <div
      data-testid="public-status"
      data-error={error ?? undefined}
      className={`mb-3 flex flex-wrap items-center gap-2 text-xs ${
        error || !catalog ? "rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-amber-500" : "text-muted-foreground"
      }`}
    >
      <span>{text}</span>
      <Button
        variant="ghost"
        size="xs"
        className={`cursor-pointer ${BUSY_BUTTON_CLASS}`}
        data-testid="public-refresh"
        focusableWhenDisabled={refreshing}
        disabled={refreshing}
        onClick={onRefresh}
      >
        {refreshing ? (
          <BusyLabel>Refreshing…</BusyLabel>
        ) : (
          <>
            <RefreshCw data-icon="inline-start" />
            Refresh
          </>
        )}
      </Button>
    </div>
  );
}

/** Beside a template of the user's own that the catalog doesn't list yet. */
export const JUST_PUBLISHED_NOTE = "Just published — the catalog may take a few minutes to list it.";
export const JUST_SHOWN_NOTE = "Public again — the catalog may take a few minutes to list it.";

/**
 * The user's own templates published (or shown again) here that libi's copy
 * of the catalog doesn't list yet — in production the site's index is
 * edge-cached for up to five minutes. Shown from `/mine` with the local
 * poster, instead of an empty tab or a missing card; the catalog route
 * re-checks every minute, and the entry becomes an ordinary card once the
 * copy lists it (lib/templates/own-catalog-view.ts).
 */
function JustListed({ items }: { items: JustListedTemplate[] }) {
  return (
    <ul data-testid="public-just-listed" className="mb-4 flex flex-col gap-2">
      {items.map((t) => {
        const local = t.local?.id ? { ...t.local, id: t.local.id } : null;
        return (
          <li
            key={t.cloudId}
            data-testid="public-just-listed-item"
            data-cloud-id={t.cloudId}
            className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card p-3"
          >
            {local?.hasPoster ? (
              // eslint-disable-next-line @next/next/no-img-element -- the studio's own media route
              <img src={mediaUrl(local, "poster.jpg")} alt="" className="h-14 w-auto shrink-0 rounded border border-border object-contain" />
            ) : null}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                <bdi>{t.name}</bdi>
              </p>
              <p className="text-xs text-muted-foreground" data-testid="public-just-listed-note">
                {t.kind === "published" ? JUST_PUBLISHED_NOTE : JUST_SHOWN_NOTE}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-3 text-xs">
              {local && (
                <Link href={templatePageHref(local.id)} className="cursor-pointer text-muted-foreground hover:text-foreground hover:underline">
                  Open your template
                </Link>
              )}
              <Link href={publicTemplatePageHref(t.cloudId)} className="cursor-pointer text-muted-foreground hover:text-foreground hover:underline">
                Public page
              </Link>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function PublicError({ onRetry }: { onRetry: () => void }) {
  return (
    <div data-testid="public-error" className="mx-auto max-w-md rounded-xl border border-destructive/40 bg-destructive/5 p-6 text-center text-sm">
      <p className="mb-4 text-muted-foreground">Couldn&rsquo;t load the public catalog.</p>
      <Button variant="outline" size="sm" className="cursor-pointer" data-testid="public-error-retry" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/**
 * The Public tab: the cached public catalog as cards, searchable by the same
 * toolbar as Mine. Opening the tab asks the catalog route, which refreshes a
 * copy older than 10 minutes (and keeps polling every 10 while open); Refresh
 * forces a fetch. An offline catalog is never presented as an empty one.
 * `view` is the page's Cards / List choice, shared with Mine; `viewPending`
 * says it can't be read yet (first paint), when neither layout is drawn.
 */
export function PublicTab({ view, viewPending = false, onView }: { view: TemplatesView; viewPending?: boolean; onView: (v: TemplatesView) => void }) {
  const catalog = useCatalogIndex();
  const refresh = useRefreshCatalog();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [showAllTags, setShowAllTags] = useState(false);
  const [order, setOrder] = useState<TemplateOrder>("trending");
  useEffect(() => {
    const h = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(h);
  }, [query]);

  // As on Mine: the unfiltered list drives the tag vocabulary and the empty
  // states; the filtered one the grid.
  const all = useTemplates({ order, scope: "public" });
  const filtered = useTemplateSearch({ q: debounced, tags: selectedTags, order, scope: "public" });
  // The user's own publishes, hides and shows the cached copy doesn't show yet:
  // `/mine` and the local rows stand in until it does (own-catalog-view.ts).
  const mine = useCloudMine();
  const local = useTemplates({ order: "trending" });
  const own = useMemo(
    () =>
      ownCatalogView({
        changes: catalog.data?.ownChanges,
        listedIds: new Set(publicOnly(all.data).map((t) => t.cloudId)),
        mine: mine.data,
        local: local.data,
      }),
    [catalog.data?.ownChanges, all.data, mine.data, local.data],
  );
  const listed = (rows: TemplateSummary[] | undefined) => publicOnly(rows).filter((t) => !own.hiddenIds.has(t.cloudId));
  const tags = useMemo(
    () => topTags(publicOnly(all.data).filter((t) => !own.hiddenIds.has(t.cloudId)).map((t) => t.tags), 1000),
    [all.data, own.hiddenIds],
  );
  const filtering = debounced.trim().length >= 2 || selectedTags.length > 0;
  const active = filtering ? filtered : all;
  const cards = listed(active.data);
  const mediaBase = catalog.data?.base ?? null;
  const justListed = own.justListed.length > 0 ? <JustListed items={own.justListed} /> : null;

  const onRefresh = () =>
    refresh.mutate(undefined, {
      onError: () => toast.error("Couldn't refresh the catalog — libi's server didn't answer."),
    });
  const status = <CatalogStatus catalog={catalog.data} failed={catalog.isError} onRefresh={onRefresh} refreshing={refresh.isPending} />;

  /**
   * The list reads libi's cached copy, so it shows as soon as it is read —
   * never held back while the catalog route refreshes that copy (up to the
   * index timeout on a slow network). Skeletons only when there is nothing
   * to show yet; posters join the cards once the route names the media base.
   */
  const skeleton = viewPending ? <TemplatesViewPendingSkeleton /> : view === "list" ? <TemplatesTableSkeleton /> : <TemplatesGridSkeleton />;
  const body = () => {
    if (!all.data) {
      if (all.isError)
        return (
          <PublicError
            onRetry={() => {
              void all.refetch();
              if (catalog.isError) void catalog.refetch();
            }}
          />
        );
      return skeleton;
    }
    if (listed(all.data).length === 0) {
      // The user's own template, just published: never "No public templates yet".
      if (justListed) return justListed;
      // Empty and offline look alike until the catalog route has answered.
      if (!catalog.data)
        return catalog.isError ? <PublicError onRetry={() => void catalog.refetch()} /> : skeleton;
      return catalog.data.error ? (
        <div data-testid="public-offline" className="mx-auto max-w-md rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          {catalogErrorCopy(catalog.data.error)}, and libi has no copy of it yet. Public templates show here once it can be
          reached.
        </div>
      ) : (
        <div data-testid="public-tab-empty" className="mx-auto max-w-md rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          No public templates yet. Publish one of yours from the Mine tab to be the first.
        </div>
      );
    }
    return (
      <>
        {justListed}
        <TemplatesToolbar
          query={query}
          onQuery={setQuery}
          tags={tags}
          selectedTags={selectedTags}
          onToggleTag={(t) => setSelectedTags((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]))}
          showAllTags={showAllTags}
          onShowAllTags={() => setShowAllTags(true)}
          order={order}
          onOrder={setOrder}
          trailing={<ViewSwitch value={view} onChange={onView} />}
        />
        {viewPending ? (
          skeleton
        ) : !active.data ? (
          active.isError ? (
            <p className="py-8 text-center text-sm text-muted-foreground" data-testid="public-search-error">
              Couldn&rsquo;t search the catalog.
            </p>
          ) : (
            skeleton
          )
        ) : cards.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground" data-testid="public-no-match">
            No public template matches.
          </p>
        ) : view === "list" ? (
          <div className={active.isPlaceholderData ? "opacity-60 transition-opacity" : ""} data-stale={active.isPlaceholderData ? "true" : undefined}>
            <PublicTemplatesTable rows={cards} />
          </div>
        ) : (
          <div className="@container">
            <ul
              className={`grid grid-cols-2 gap-4 @2xl:grid-cols-3 ${active.isPlaceholderData ? "opacity-60 transition-opacity" : ""}`}
              data-testid="public-grid"
              data-stale={active.isPlaceholderData ? "true" : undefined}
            >
              {cards.map((e) => (
                <PublicTemplateCard key={e.cloudId} entry={e} mediaBase={mediaBase} />
              ))}
            </ul>
          </div>
        )}
      </>
    );
  };

  return (
    <div data-testid="public-tab">
      {status}
      {body()}
    </div>
  );
}
