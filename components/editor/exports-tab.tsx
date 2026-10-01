"use client";

import { useMemo, useState } from "react";
import { Film, MoreVertical, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { MediaSrcView } from "@/components/editor/asset-media-view";
import { ExportContextMenu, type ExportMenuState } from "@/components/exports/export-context-menu";
import { ExportDeleteDialog } from "@/components/exports/export-delete-dialog";
import { ExportRenameInput } from "@/components/exports/export-rename-input";
import { useExportActions } from "@/hooks/exports/use-export-actions";
import { requestExportDialog } from "@/hooks/social/use-posting-intent";
import { useExports } from "@/lib/queries/exports";
import {
  EXPORT_SORT_LABELS,
  activeLine,
  activePercent,
  aspectsPresent,
  exportTime,
  filterExports,
  formatBytes,
  formatDuration,
  formatExportTime,
  loadExportSort,
  saveExportSort,
  sortExports,
  visibleInTab,
  type ExportSort,
} from "@/lib/exports/list-view";
import { isActiveExport, type ExportAspect, type ExportRecordView } from "@/lib/exports/types";

/**
 * The tab lays itself out by its OWN width (a CSS container query), not the window's: the
 * resources panel can leave the editor ~520 px wide at any window size. At or above
 * `SIDE_BY_SIDE_MIN_PX` the list (380 px) and the player (>= 320 px) sit side by side; below it
 * the player stacks ABOVE the list at full width, so it is never squeezed to a sliver.
 * Container queries are not measurable in jsdom — the test asserts these class contracts.
 */
export const EXPORTS_LIST_WIDTH_PX = 380;
export const EXPORTS_PLAYER_MIN_PX = 320;
export const SIDE_BY_SIDE_MIN_PX = EXPORTS_LIST_WIDTH_PX + EXPORTS_PLAYER_MIN_PX;
export const EXPORTS_LAYOUT = {
  root: "@container h-full min-h-0",
  frame: "flex h-full min-h-0 flex-col @[700px]:flex-row",
  list: "flex min-h-0 w-full flex-1 flex-col border-t border-border @[700px]:w-[380px] @[700px]:flex-none @[700px]:shrink-0 @[700px]:border-t-0 @[700px]:border-r",
  player: "order-first h-[45%] min-h-[220px] w-full shrink-0 @[700px]:order-none @[700px]:h-auto @[700px]:min-h-0 @[700px]:min-w-[320px] @[700px]:flex-1",
} as const;

interface ExportsTabProps {
  pieceId: string;
  selectedExportId: string | null;
  onSelectExport: (exportId: string | null) => void;
}

/**
 * The piece's Exports tab (spec 2026-09-29 §A4): the list on the left — sort,
 * aspect filter, search, one row per export — and the selected export playing
 * on the right. Reads `useExports`; every change arrives over the one SSE.
 */
export function ExportsTab({ pieceId, selectedExportId, onSelectExport }: ExportsTabProps) {
  const { data, isLoading } = useExports(pieceId);
  const actions = useExportActions("tab");
  const [sort, setSort] = useState<ExportSort>(() => loadExportSort());
  const [aspect, setAspect] = useState<ExportAspect | "all">("all");
  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState<ExportMenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ExportRecordView | null>(null);

  const all = useMemo(() => visibleInTab(data ?? []), [data]);
  const aspects = useMemo(() => aspectsPresent(all), [all]);
  // A chosen aspect whose last export went away falls back to All.
  const activeAspect: ExportAspect | "all" = aspect !== "all" && !aspects.includes(aspect) ? "all" : aspect;
  const rows = useMemo(() => sortExports(filterExports(all, { aspect: activeAspect, search }), sort), [all, activeAspect, search, sort]);
  const selected = all.find((e) => e.id === selectedExportId) ?? null;

  if (isLoading) return <ExportsSkeleton />;

  if (all.length === 0) {
    return (
      <div data-testid="exports-empty" className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <Film className="h-6 w-6" />
        <span>No exports yet</span>
        <Button size="sm" className="cursor-pointer" onClick={() => requestExportDialog(pieceId)}>
          Export…
        </Button>
      </div>
    );
  }

  const chooseSort = (next: ExportSort) => {
    setSort(next);
    saveExportSort(next);
  };

  return (
    <div className={EXPORTS_LAYOUT.root}>
      <div data-testid="exports-tab" className={EXPORTS_LAYOUT.frame}>
        <div data-testid="exports-list" className={EXPORTS_LAYOUT.list}>
          <div className="flex flex-col gap-2 border-b border-border p-2">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search exports"
                  aria-label="Search exports"
                  className="h-7 pl-7 text-xs"
                />
              </div>
              <select
                aria-label="Sort exports"
                value={sort}
                onChange={(e) => chooseSort(e.target.value as ExportSort)}
                className="h-7 cursor-pointer rounded-md border border-input bg-background px-1.5 text-xs"
              >
                {(Object.keys(EXPORT_SORT_LABELS) as ExportSort[]).map((s) => (
                  <option key={s} value={s}>
                    {EXPORT_SORT_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <div role="group" aria-label="Filter by aspect" className="flex flex-wrap gap-1">
              {(["all", ...aspects] as Array<ExportAspect | "all">).map((a) => (
                <button
                  key={a}
                  type="button"
                  aria-pressed={activeAspect === a}
                  onClick={() => setAspect(a)}
                  className={
                    "cursor-pointer rounded-full px-2 py-0.5 text-[11px] " +
                    (activeAspect === a ? "bg-primary text-primary-foreground" : "bg-muted text-foreground hover:bg-muted/70")
                  }
                >
                  {a === "all" ? "All" : a}
                </button>
              ))}
            </div>
          </div>
          <ul aria-label="Exports" className="min-h-0 flex-1 overflow-auto p-1">
            {rows.map((e) => (
              <ExportRow
                key={e.id}
                exp={e}
                selected={e.id === selectedExportId}
                renaming={e.id === renamingId}
                onSelect={() => onSelectExport(e.id)}
                onMenu={(x, y) => setMenu({ x, y, exp: e })}
                onRenameDone={(name) => {
                  setRenamingId(null);
                  if (name !== null && name.trim() && name.trim() !== e.name) void actions.rename(e, name);
                }}
                onRemove={() => void actions.remove(e)}
              />
            ))}
          </ul>
          {rows.length === 0 && <p className="p-3 text-xs text-muted-foreground">No exports match.</p>}
        </div>
        <div data-testid="exports-player" className={EXPORTS_LAYOUT.player}>
          {selected && selected.status === "done" && !selected.missing ? (
            <MediaSrcView
              key={selected.id}
              src={`/api/exports/${selected.id}/content`}
              boxKey={`export:${selected.id}`}
              width={selected.width}
              height={selected.height}
              onPlay={actions.played}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {selected?.missing ? "Missing file" : "Select an export to play it."}
            </div>
          )}
        </div>
        {menu && (
          <ExportContextMenu
            state={menu}
            revealLabel={actions.revealLabel}
            onPost={actions.post}
            onReveal={(e) => void actions.reveal(e)}
            onCopy={(e) => void actions.copy(e)}
            onRename={(e) => setRenamingId(e.id)}
            onDelete={setPendingDelete}
            onClose={() => setMenu(null)}
          />
        )}
        <ExportDeleteDialog
          exp={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={(e) => {
            setPendingDelete(null);
            if (e.id === selectedExportId) onSelectExport(null);
            void actions.remove(e);
          }}
        />
      </div>
    </div>
  );
}

function ExportRow({
  exp,
  selected,
  renaming,
  onSelect,
  onMenu,
  onRenameDone,
  onRemove,
}: {
  exp: ExportRecordView;
  selected: boolean;
  renaming: boolean;
  onSelect: () => void;
  onMenu: (x: number, y: number) => void;
  onRenameDone: (name: string | null) => void;
  onRemove: () => void;
}) {
  const active = isActiveExport(exp);
  const done = exp.status === "done";
  const pct = activePercent(exp);
  return (
    <li
      data-testid={`export-row-${exp.id}`}
      className={
        "mb-1 rounded-md border px-2 py-1.5 " + (selected ? "border-primary/60 bg-accent" : "border-transparent hover:bg-accent/60")
      }
      onContextMenu={(ev) => {
        if (!done) return;
        ev.preventDefault();
        onMenu(ev.clientX, ev.clientY);
      }}
    >
      <div className="flex items-center gap-2">
        {renaming ? (
          <ExportRenameInput initial={exp.name} onDone={onRenameDone} />
        ) : (
          <button type="button" onClick={onSelect} className="min-w-0 flex-1 cursor-pointer truncate text-left text-xs font-medium">
            {exp.name}
          </button>
        )}
        {done && !renaming && (
          <button
            type="button"
            aria-label={`Actions for ${exp.name}`}
            onClick={(ev) => onMenu(ev.clientX, ev.clientY)}
            className="cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {done && (
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>{formatExportTime(exportTime(exp))}</span>
          <span className="rounded bg-muted px-1 text-foreground">
            {exp.aspect === "other" && exp.width && exp.height ? `${exp.width}×${exp.height}` : exp.aspect}
          </span>
          <span>{formatBytes(exp.sizeBytes)}</span>
          <span>{formatDuration(exp.durationSec)}</span>
          {exp.carriesCopyrighted && <span className="rounded bg-amber-500/15 px-1 text-amber-700 dark:text-amber-300">Copyrighted music</span>}
          {exp.missing && <span className="rounded bg-amber-500/15 px-1 text-amber-700 dark:text-amber-300">Missing file</span>}
        </div>
      )}
      {active && (
        <>
          <div className="mt-1 flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded bg-muted">
              <div
                className={"h-full bg-primary " + (pct == null ? "w-1/3 animate-pulse" : "transition-[width]")}
                style={pct == null ? undefined : { width: `${pct}%` }}
              />
            </div>
            <Button variant="ghost" size="xs" className="cursor-pointer" onClick={onRemove}>
              Cancel
            </Button>
          </div>
          <div role="status" className="mt-0.5 text-[11px] text-muted-foreground">
            {activeLine(exp)}
          </div>
        </>
      )}
      {exp.status === "failed" && (
        <div className="mt-1 flex items-start gap-2">
          <p className="flex-1 break-words text-[11px] text-red-600 dark:text-red-400">{exp.error ?? "The export failed."}</p>
          <Button variant="ghost" size="xs" className="cursor-pointer" onClick={onRemove}>
            Dismiss
          </Button>
        </div>
      )}
    </li>
  );
}

function ExportsSkeleton() {
  return (
    <div data-testid="exports-skeleton" className={EXPORTS_LAYOUT.root}>
      <div className={EXPORTS_LAYOUT.frame}>
        <div className={EXPORTS_LAYOUT.list + " gap-2 p-2"}>
          <Skeleton className="h-7 w-full" />
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-1 rounded-md px-2 py-1.5">
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="h-3 w-full" />
            </div>
          ))}
        </div>
        <div className={EXPORTS_LAYOUT.player + " p-4"}>
          <Skeleton className="h-full w-full" />
        </div>
      </div>
    </div>
  );
}
