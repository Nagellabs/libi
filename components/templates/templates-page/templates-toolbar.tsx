"use client";

import type { ReactNode } from "react";
import { SearchBox } from "@/components/social/social-page/list-views";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { TemplateOrder } from "@/lib/templates/types";

export const ORDER_LABELS: Record<TemplateOrder, string> = {
  trending: "Trending",
  "most-used": "Most used",
  newest: "Newest",
};
const TAG_CHIP_LIMIT = 12;

/** Top tags by count across `allTags` (the unfiltered list), most frequent first, ties alphabetical. */
export function topTags(allTags: string[][], limit = TAG_CHIP_LIMIT): string[] {
  const counts = new Map<string, number>();
  for (const tags of allTags) for (const t of tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([t]) => t);
}

/**
 * Search, order and tag chips. The chips are capped at twelve because the tag
 * vocabulary is the agent's, not a fixed list — a library with fifty tags
 * would otherwise push the grid off the first screen.
 */
export function TemplatesToolbar({
  query,
  onQuery,
  tags,
  selectedTags,
  onToggleTag,
  showAllTags,
  onShowAllTags,
  order,
  onOrder,
  trailing,
}: {
  query: string;
  onQuery: (q: string) => void;
  tags: string[];
  selectedTags: string[];
  onToggleTag: (t: string) => void;
  showAllTags: boolean;
  onShowAllTags: () => void;
  order: TemplateOrder;
  onOrder: (o: TemplateOrder) => void;
  /** Right-aligned on the search row — the Cards / List switch. */
  trailing?: ReactNode;
}) {
  const visible = showAllTags ? tags : tags.slice(0, TAG_CHIP_LIMIT);
  return (
    <div className="mb-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={query} onChange={onQuery} placeholder="Search templates" />
        <Select items={ORDER_LABELS} value={order} onValueChange={(v) => onOrder(v as TemplateOrder)}>
          <SelectTrigger className="w-36 cursor-pointer text-xs" data-testid="templates-order" aria-label="Order">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(ORDER_LABELS) as TemplateOrder[]).map((o) => (
              <SelectItem key={o} value={o} className="cursor-pointer" data-testid={`templates-order-${o}`}>
                {ORDER_LABELS[o]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {trailing ? <div className="ml-auto">{trailing}</div> : null}
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="template-tag-chips">
          {visible.map((t) => {
            const on = selectedTags.includes(t);
            return (
              <button
                key={t}
                type="button"
                data-testid="template-tag-chip"
                aria-pressed={on}
                onClick={() => onToggleTag(t)}
                className={`cursor-pointer rounded-full border px-2 py-0.5 text-xs ${
                  on ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {t}
              </button>
            );
          })}
          {!showAllTags && tags.length > TAG_CHIP_LIMIT && (
            <button
              type="button"
              onClick={onShowAllTags}
              className="cursor-pointer text-xs text-muted-foreground hover:text-foreground"
              data-testid="template-tags-more"
            >
              more…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
