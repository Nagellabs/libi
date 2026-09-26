import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors the connected-accounts strip: 2 account cards. */
export function AccountsStripSkeleton() {
  return (
    <div data-testid="accounts-strip-skeleton" className="flex flex-wrap gap-3">
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="flex items-center gap-2 rounded-lg border border-border bg-card p-3">
          <Skeleton className="size-8 rounded-full" />
          <div className="space-y-1.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Mirrors a list of `PostRow` cards. */
export function PostListSkeleton() {
  return (
    <ul data-testid="post-list-skeleton" className="space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <li key={i} className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
          <Skeleton className="size-12 shrink-0 rounded-md" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Mirrors `PostDetailSheet`'s body: media on one side, caption + meta on the other. */
export function PostDetailSkeleton() {
  return (
    <div data-testid="post-detail-skeleton" className="grid grid-cols-2 gap-4">
      <Skeleton className="h-48 w-full rounded-md" />
      <div className="space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-20 w-full" />
      </div>
    </div>
  );
}

/** Mirrors the Social page's table view: a header and five rows. */
export function ListTableSkeleton() {
  return (
    <div data-testid="list-table-skeleton" className="space-y-2 rounded-xl border border-border p-3">
      <Skeleton className="h-4 w-full" />
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-10 shrink-0 rounded-md" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-3 w-12" />
        </div>
      ))}
    </div>
  );
}

/** Mirrors the Social page's grid view: cards with a tall thumbnail. */
export function ListGridSkeleton() {
  return (
    <div data-testid="list-grid-skeleton" className="@container">
      <div className="grid grid-cols-2 gap-4 @2xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="overflow-hidden rounded-xl border border-border">
            <Skeleton className="aspect-square w-full rounded-none" />
            <div className="space-y-2 p-3">
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-3 w-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
