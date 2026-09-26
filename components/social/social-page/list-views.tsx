"use client";

import { useState, useSyncExternalStore } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, LayoutGrid, Search, Table2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { TableHead } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { PlatformIcon } from "@/components/social/platform-icon";

export type ListView = "table" | "grid";

/**
 * Table or grid, remembered per list. `localStorage` is a per-viewer
 * convenience here and nothing more — every read and write is guarded, and a
 * browser that refuses it simply opens on the table each time. Read through
 * `useSyncExternalStore` so the server render (no storage) and the first
 * client render agree, and the remembered view lands right after hydration.
 */
const viewListeners = new Set<() => void>();

function readView(storageKey: string): ListView {
  try {
    return window.localStorage.getItem(storageKey) === "grid" ? "grid" : "table";
  } catch {
    return "table";
  }
}

export function useListView(key: string): [ListView, (v: ListView) => void] {
  const storageKey = `libi.social.view.${key}`;
  const [fallback, setFallback] = useState<ListView | null>(null);
  const stored = useSyncExternalStore(
    (cb) => {
      viewListeners.add(cb);
      return () => viewListeners.delete(cb);
    },
    () => readView(storageKey),
    () => "table" as ListView,
  );
  const setView = (v: ListView) => {
    try {
      window.localStorage.setItem(storageKey, v);
    } catch {
      // Not remembered — still switched, for this visit.
      setFallback(v);
    }
    for (const cb of viewListeners) cb();
  };
  return [fallback ?? stored, setView];
}

export function ViewToggle({ value, onChange }: { value: ListView; onChange: (v: ListView) => void }) {
  const options: Array<{ v: ListView; label: string; Icon: typeof Table2 }> = [
    { v: "table", label: "Table — every number, sortable", Icon: Table2 },
    { v: "grid", label: "Grid — the posts themselves", Icon: LayoutGrid },
  ];
  return (
    <TooltipProvider>
      <div role="group" aria-label="View" className="inline-flex shrink-0 rounded-lg border border-border p-0.5" data-testid="view-toggle">
        {options.map(({ v, label, Icon }) => (
          <Tooltip key={v}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={label}
                  aria-pressed={value === v}
                  data-testid={`view-toggle-${v}`}
                  onClick={() => onChange(v)}
                  className={`inline-flex size-7 cursor-pointer items-center justify-center rounded-md ${
                    value === v ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                />
              }
            >
              <Icon className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative min-w-48 flex-1 basis-56">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        aria-label="Search"
        data-testid="list-search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 pl-8 text-xs"
      />
    </div>
  );
}

export type SortDir = "asc" | "desc";
export interface SortState<K extends string> {
  key: K;
  dir: SortDir;
}

/**
 * A column header that sorts. Numbers open DESCENDING — "which post did best"
 * is the question a click on "Views" asks — and a second click flips it.
 */
export function SortHead<K extends string>({
  label,
  k,
  sort,
  onSort,
  align = "right",
}: {
  label: string;
  k: K;
  sort: SortState<K> | null;
  onSort: (s: SortState<K>) => void;
  align?: "left" | "right";
}) {
  const active = sort?.key === k;
  const Icon = !active ? ArrowUpDown : sort.dir === "desc" ? ArrowDown : ArrowUp;
  return (
    <TableHead
      aria-sort={active ? (sort.dir === "desc" ? "descending" : "ascending") : "none"}
      className={align === "right" ? "text-right" : undefined}
    >
      <button
        type="button"
        data-testid={`sort-${k}`}
        onClick={() => onSort({ key: k, dir: active && sort.dir === "desc" ? "asc" : "desc" })}
        className={`inline-flex cursor-pointer items-center gap-1 hover:text-foreground ${active ? "text-foreground" : ""}`}
      >
        {label}
        <Icon className={`size-3 ${active ? "" : "opacity-40"}`} />
      </button>
    </TableHead>
  );
}

/** Sort rows by a numeric (or ISO-date) value; rows with no value always sink
 *  to the bottom, whichever way — "no figure yet" is not the smallest figure. */
export function sortRows<T>(rows: T[], dir: SortDir, value: (r: T) => number | undefined): T[] {
  return rows
    .map((r, i) => ({ r, i, v: value(r) }))
    .sort((a, b) => {
      if (a.v === undefined && b.v === undefined) return a.i - b.i;
      if (a.v === undefined) return 1;
      if (b.v === undefined) return -1;
      return dir === "desc" ? b.v - a.v : a.v - b.v;
    })
    .map((x) => x.r);
}

/**
 * A post's or ad's picture — or, when there is none or it will not load (a
 * provider's temporary media URL expires), a plain tile with the network's
 * mark, so the grid never shows a hole where a picture should be.
 */
export function Thumb({
  media,
  className,
  platform,
}: {
  media?: { url: string; type: "video" | "image" };
  className: string;
  platform?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!media || failedUrl === media.url) {
    return (
      <div className={`flex items-center justify-center bg-muted text-muted-foreground/40 ${className}`} data-testid="thumb-fallback">
        {platform && <PlatformIcon platform={platform} className="size-1/4 max-h-10 max-w-10 min-h-3 min-w-3" />}
      </div>
    );
  }
  const onError = () => setFailedUrl(media.url);
  if (media.type === "video") {
    return <video muted preload="metadata" src={media.url} onError={onError} className={`bg-muted object-cover ${className}`} />;
  }
  // eslint-disable-next-line @next/next/no-img-element -- thumbnail source is a remote/provider URL, not a static asset
  return <img src={media.url} alt="" onError={onError} className={`bg-muted object-cover ${className}`} />;
}
