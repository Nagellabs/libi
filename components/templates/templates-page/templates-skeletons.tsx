import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors the card grid: six cards with a poster block, two text lines and a chip row. */
export function TemplatesGridSkeleton() {
  return (
    <div className="@container">
      <ul data-testid="templates-grid-skeleton" className="grid grid-cols-2 gap-4 @2xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <li key={i} className="overflow-hidden rounded-xl border border-border bg-card">
            <Skeleton className="aspect-[9/16] max-h-64 w-full rounded-none" />
            <div className="space-y-2 p-3">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-full" />
              <div className="flex gap-1">
                <Skeleton className="h-5 w-12 rounded-full" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Mirrors "Your templates": a header row and four rows of name, status, two counts, sparkline and date. */
export function TemplatesTableSkeleton() {
  return (
    <div data-testid="templates-table-skeleton" className="mt-8 space-y-2 rounded-xl border border-border p-3">
      <Skeleton className="h-4 w-full" />
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-10" />
          <Skeleton className="h-3 w-10" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

/**
 * Before the page can read which view this browser chose (the server render
 * and hydration): one block that is neither the grid nor the table, so a
 * stored List view never paints as Cards first and then flips (review M8).
 */
export function TemplatesViewPendingSkeleton() {
  return <Skeleton data-testid="templates-view-pending" className="h-72 w-full rounded-xl" />;
}
