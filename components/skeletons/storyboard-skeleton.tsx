import { Fragment } from "react";
import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors a single StoryboardCard: header row, the 3-tier 9:16 thumbnail strip
 *  with arrows, the details row, and a prompt block — so the loading state has
 *  the same footprint as the real cards instead of a single line of text. */
export function CardSkeleton() {
  return (
    <div className="shrink-0 rounded-lg border border-border bg-card/40 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-3.5 w-16" />
          <Skeleton className="h-3.5 w-24" />
        </div>
        <Skeleton className="h-4 w-20 rounded-full" />
      </div>

      {/* Tier strip — three 9:16 cells joined by arrows */}
      <div className="flex items-start gap-2 p-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <div className="mt-[-20px] flex items-center self-center text-sm text-muted-foreground/30">
                →
              </div>
            )}
            <div className="flex max-w-[180px] flex-1 flex-col gap-1.5">
              <Skeleton className="aspect-[9/16] w-full rounded-md" />
              <Skeleton className="h-2.5 w-3/4" />
              <Skeleton className="h-4 w-20 rounded-full" />
              <Skeleton className="h-5 w-full rounded" />
            </div>
          </Fragment>
        ))}
      </div>

      {/* Details row */}
      <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-border/40 px-3 py-2.5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-1">
            <Skeleton className="h-2 w-10" />
            <Skeleton className="h-3 w-14" />
          </div>
        ))}
      </div>

      {/* Prompt block */}
      <div className="px-3 pb-3">
        <Skeleton className="h-10 w-full rounded" />
      </div>
    </div>
  );
}

interface Props {
  count?: number;
}

export function StoryboardSkeleton({ count = 3 }: Props) {
  return (
    <div className="flex flex-1 min-h-0 flex-col gap-3 overflow-hidden p-3">
      {Array.from({ length: count }).map((_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  );
}

/** Board-shaped loading state: a centered, balanced grid of card skeletons at
 *  the same ~420px width as the real React Flow nodes. Shown over the board
 *  while the initial fit-to-view settles, so the user never sees the cards
 *  jump from their raw positions into the centered viewport. */
export function StoryboardBoardSkeleton({ count = 3 }: Props) {
  // Clamp to a sane on-screen range and mirror the board's balanced grid.
  const shown = Math.min(6, Math.max(2, count));
  const cols = Math.max(1, Math.ceil(Math.sqrt(shown)));
  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden p-6">
      <div
        className="grid gap-10"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 420px))` }}
      >
        {Array.from({ length: shown }).map((_, i) => (
          <div key={i} className="w-full max-w-[420px]">
            <CardSkeleton />
          </div>
        ))}
      </div>
    </div>
  );
}
