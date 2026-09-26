"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TemplatePromptButton } from "@/components/templates/template-prompt-button";
import { TemplateCard, type InstalledTemplate } from "@/components/templates/templates-page/template-card";
import { PublicTab } from "@/components/templates/templates-page/public-tab";
import { PublishingAs } from "@/components/templates/templates-page/publishing-as";
import { DevelopmentCatalogBadge } from "@/components/templates/templates-page/catalog-badge";
import { PublishReviews } from "@/components/templates/templates-page/publish-review";
import { cloudOnlyEntries, TemplatesTable } from "@/components/templates/templates-page/templates-table";
import { ViewSwitch } from "@/components/templates/templates-page/view-switch";
import { TemplatesToolbar, topTags } from "@/components/templates/templates-page/templates-toolbar";
import { TemplatesGridSkeleton, TemplatesTableSkeleton, TemplatesViewPendingSkeleton } from "@/components/templates/templates-page/templates-skeletons";
import {
  TEMPLATES_TABS,
  useTemplatesPageParams,
  type TemplatesTab,
} from "@/components/templates/templates-page/use-templates-page-params";
import { useCatalogIndex, useTemplateSearch, useTemplates } from "@/lib/queries/templates";
import { useCloudMine } from "@/lib/queries/templates-cloud";
import type { MineTemplate } from "@/lib/templates/cloud/client";
import type { TemplateOrder, TemplateSummary } from "@/lib/templates/types";

const TAB_LABELS: Record<TemplatesTab, string> = { mine: "Mine", public: "Public" };

/**
 * The Cards view's line about templates this creator key published that have
 * no copy here — they are rows in List view only — naming how many of them
 * moderation removed, since List view is where their reason and How to
 * dispute show (review M7).
 */
export function cloudOnlyNoteText(count: number, removed: number): string {
  const lead =
    count === 1
      ? "1 published template isn't on this machine — see it in List view."
      : `${count} published templates aren't on this machine — see them in List view.`;
  if (removed === 0) return lead;
  if (count === 1) return `${lead} It was removed from the catalog: List view says why, and how to dispute it.`;
  return removed === 1
    ? `${lead} 1 of them was removed from the catalog: List view says why, and how to dispute it.`
    : `${lead} ${removed} of them were removed from the catalog: List view says why, and how to dispute them.`;
}

/** Only rows that exist on this machine can be opened, used or deleted. */
function installed(rows: TemplateSummary[] | undefined): InstalledTemplate[] {
  return (rows ?? []).filter((t): t is InstalledTemplate => t.id !== null);
}

/**
 * A read that failed with NOTHING to show says so and offers the retry.
 * Without this a dead `/api/templates` renders as "you have no templates" — an
 * empty library and a broken one are not the same thing, and only one of them
 * is the user's fault.
 */
function TemplatesError({ testId, onRetry }: { testId: string; onRetry: () => void }) {
  return (
    <div
      data-testid={testId}
      className="mx-auto max-w-md rounded-xl border border-destructive/40 bg-destructive/5 p-6 text-center text-sm"
    >
      <p className="mb-4 text-muted-foreground">Couldn&rsquo;t load templates.</p>
      <Button variant="outline" size="sm" className="cursor-pointer" data-testid={`${testId}-retry`} onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/**
 * A refresh that failed while the page still HAS templates is a different
 * event: the rows on screen are real, just not current. Taking them away for
 * a full error state would punish the user for a background fetch they never
 * started — a delete's invalidate, or an SSE `refresh_query`.
 */
function RefreshFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      data-testid="templates-refresh-failed"
      className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500"
    >
      <span>Couldn&rsquo;t refresh templates — showing what was last loaded.</span>
      <Button
        variant="ghost"
        size="xs"
        className="cursor-pointer text-amber-500 hover:text-amber-400"
        data-testid="templates-refresh-failed-retry"
        onClick={onRetry}
      >
        Retry
      </Button>
    </div>
  );
}

export function TemplatesPage() {
  const { tab, template: highlightId, review: reviewId, setTab, view, viewPending, setView } = useTemplatesPageParams();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [showAllTags, setShowAllTags] = useState(false);
  const [order, setOrder] = useState<TemplateOrder>("trending");
  useEffect(() => {
    const h = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(h);
  }, [query]);

  // Two hooks, one endpoint: `useTemplates` ignores `q`/`tags` by design, so
  // the filtered view has to come from `useTemplateSearch`. With no filter the
  // two normalize to the same query key, so this costs no extra request — and
  // `all` stays the source for the tag vocabulary, the empty state and which
  // published templates have a copy here: they describe the whole library,
  // not the filter.
  const all = useTemplates({ order });
  const filtered = useTemplateSearch({ q: debounced, tags: selectedTags, order });
  // The catalog's copy is refreshed when the PAGE opens, whichever tab, and
  // every 10 minutes while it is open (the hook polls) — agents searching
  // `scope: "public"` read the same cache.
  useCatalogIndex();
  // What this install published, even with no local copy of it: "Your
  // templates" is the creator's only way to hide those.
  const mine = useCloudMine();
  const cloudOnly = (mine.data?.templates.length ?? 0) > 0;
  // This creator key's published templates by catalog id: a card shows its catalog status and Hide / Show again.
  const publishedById = useMemo(() => new Map((mine.data?.templates ?? []).map((m) => [m.id, m])), [mine.data]);
  const tags = useMemo(() => topTags((all.data ?? []).map((t) => t.tags), 1000), [all.data]);
  const filtering = debounced.trim().length >= 2 || selectedTags.length > 0;
  const active = filtering ? filtered : all;
  const cards = installed(active.data);
  // Published under this key with no copy on this machine: rows in List view only.
  const away = cloudOnlyEntries(all.data ?? [], mine.data?.templates);
  // The toolbar's filter, applied to those rows by what `/mine` knows of them —
  // a name, no tags — so a tag filter leaves them out.
  const needle = debounced.trim().toLowerCase();
  const cloudOnlyFilter = filtering
    ? (m: MineTemplate) => selectedTags.length === 0 && m.name.toLowerCase().includes(needle)
    : undefined;
  // A failure that still has rows behind it is a stale page, not a broken one.
  const staleAll = all.isError && !!all.data;
  const staleFiltered = filtering && filtered.isError && !!filtered.data;
  const retryRefresh = () => {
    if (staleAll) void all.refetch();
    if (staleFiltered) void filtered.refetch();
  };

  useEffect(() => {
    if (!highlightId || !active.data) return;
    document.querySelector(`[data-template-id="${CSS.escape(highlightId)}"]`)?.scrollIntoView({ block: "center" });
  }, [highlightId, active.data]);

  /**
   * The grid region only. The toolbar above it stays mounted whatever this
   * returns: replacing the whole body with skeletons took the focus out of the
   * search box on the second character, and pulled a tag chip out from under
   * the pointer.
   *
   * The skeleton is for having NOTHING to show. Once there are rows — the
   * previous filter's, kept by `placeholderData` — they stay on screen and
   * only dim while the next answer loads.
   */
  const grid = () => {
    if (!active.data)
      return active.isError ? (
        <TemplatesError testId="templates-grid-error" onRetry={() => void active.refetch()} />
      ) : (
        <TemplatesGridSkeleton />
      );
    // Published here but not on this machine, as far as the filter lets through.
    const awayShown = cloudOnlyFilter ? away.filter(cloudOnlyFilter) : away;
    const note =
      awayShown.length > 0 ? (
        <p className="mb-3 text-xs text-muted-foreground" data-testid="templates-cloud-only-note">
          {cloudOnlyNoteText(awayShown.length, awayShown.filter((m) => m.moderated).length)}{" "}
          <Button variant="link" size="xs" className="h-auto cursor-pointer p-0 text-xs" onClick={() => setView("list")}>
            Show List view
          </Button>
        </p>
      ) : null;
    return (
      <div className="@container">
        {/* "Your templates" is the name Terms §11 gives this screen, in either view — keep the heading. */}
        <h2 className="mb-2 text-sm font-semibold" data-testid="templates-your-templates">
          Your templates
        </h2>
        {cards.length === 0 && !note ? (
          <p className="py-8 text-center text-sm text-muted-foreground" data-testid="templates-no-match">
            No template matches.
          </p>
        ) : (
          <>
            {cards.length === 0 && (
              <p className="mb-2 text-sm text-muted-foreground" data-testid="templates-no-local-match">
                No template on this machine matches.
              </p>
            )}
            {note}
            {cards.length > 0 && (
              <ul
                className={`grid grid-cols-2 gap-4 @2xl:grid-cols-3 ${active.isPlaceholderData ? "opacity-60 transition-opacity" : ""}`}
                data-testid="templates-grid"
                data-stale={active.isPlaceholderData ? "true" : undefined}
              >
                {cards.map((t) => (
                  <TemplateCard
                    key={t.id}
                    t={t}
                    highlighted={t.id === highlightId}
                    published={t.origin === "local" && t.cloudId ? (publishedById.get(t.cloudId) ?? null) : null}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    );
  };

  /**
   * The List view: "Your templates" — every local template the toolbar lets
   * through, with its use counts, and the catalog's side of the published
   * ones (visibility, Hide / Show again, a moderated template's reason and
   * How to dispute), plus published templates with no copy here.
   */
  const list = () => {
    if (!active.data)
      return active.isError ? (
        <TemplatesError testId="templates-grid-error" onRetry={() => void active.refetch()} />
      ) : (
        <TemplatesTableSkeleton />
      );
    if (active.data.length === 0 && (cloudOnlyFilter ? away.filter(cloudOnlyFilter) : away).length === 0)
      return (
        <p className="py-8 text-center text-sm text-muted-foreground" data-testid="templates-no-match">
          No template matches.
        </p>
      );
    return (
      <div className={active.isPlaceholderData ? "opacity-60 transition-opacity" : ""} data-stale={active.isPlaceholderData ? "true" : undefined}>
        <TemplatesTable rows={active.data} known={all.data ?? []} cloudOnlyFilter={cloudOnlyFilter} className="" />
      </div>
    );
  };

  const body = () => {
    if (tab === "public") return <PublicTab view={view} viewPending={viewPending} onView={setView} />;
    // Everything below the tabs is driven by the UNFILTERED list: whether the
    // library loaded at all, whether it is empty, and what the toolbar offers.
    if (!all.data)
      return all.isError ? (
        <TemplatesError testId="templates-error" onRetry={() => void all.refetch()} />
      ) : viewPending ? (
        <TemplatesViewPendingSkeleton />
      ) : view === "list" ? (
        <TemplatesTableSkeleton />
      ) : (
        <TemplatesGridSkeleton />
      );
    if (all.data.length === 0) {
      // No local template, but ones this creator key published: listed, with
      // their visibility control, not hidden behind the empty state.
      if (cloudOnly)
        return (
          <>
            <p className="mb-2 text-sm text-muted-foreground" data-testid="templates-none-local">
              No templates on this machine. The ones you published are below.
            </p>
            <TemplatesTable rows={[]} />
          </>
        );
      // "Nothing" only once the catalog has had its say.
      if (mine.isPending) return <TemplatesTableSkeleton />;
      return (
        <div
          data-testid="templates-empty"
          className="mx-auto max-w-md rounded-xl border border-border bg-card p-6 text-center text-sm"
        >
          <p className="mb-4 text-muted-foreground">
            A template is a reusable video concept: the agent&rsquo;s instructions, the overlays, clips and media of a
            piece you already made, applied to a new piece in one step. Make one from a piece you like and use it again
            and again.
          </p>
          <TemplatePromptButton
            kind="create"
            ctx={{}}
            label="Ask the agent to make a template from a piece"
            variant="default"
            testId="templates-empty-create"
          />
        </div>
      );
    }
    return (
      <>
        {(staleAll || staleFiltered) && <RefreshFailed onRetry={retryRefresh} />}
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
          trailing={<ViewSwitch value={view} onChange={setView} />}
        />
        {viewPending ? <TemplatesViewPendingSkeleton /> : view === "list" ? list() : grid()}
      </>
    );
  };

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold">Templates</h1>
            <DevelopmentCatalogBadge />
          </div>
          <p className="text-sm text-muted-foreground">
            Reusable video concepts captured from your pieces. Use one to start a piece; ask the agent to make one from
            a piece you like.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <TemplatePromptButton kind="create" ctx={{}} label="Make a template from a piece" testId="templates-create" />
          <PublishingAs />
        </div>
      </header>
      {/* Publishes an agent prepared: only the user publishes them, here. */}
      <PublishReviews highlightId={reviewId} />
      <Tabs value={tab} onValueChange={(v) => setTab(v as TemplatesTab)}>
        {/* The editor panel's and the Social page's tab row, exactly — one tab
            treatment across the app. */}
        <div className="-mx-6 mb-4 flex items-center border-b border-border bg-muted px-6">
          <TabsList className="bg-transparent">
            {TEMPLATES_TABS.map((t) => (
              <TabsTrigger key={t} value={t} className="cursor-pointer" data-testid={`templates-tab-${t}`}>
                {TAB_LABELS[t]}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </Tabs>
      {body()}
    </div>
  );
}
