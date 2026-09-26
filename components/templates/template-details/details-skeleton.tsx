import { Skeleton } from "@/components/ui/skeleton";

/**
 * A template's page while it loads, in the page's own shape
 * (`DetailsLayout`): the back link, the player box beside three header lines,
 * a button row and the usage box, then the Overlays table and the Resources
 * grid below.
 */
export function DetailsSkeleton({ canvas }: { canvas?: { width: number; height: number } | null }) {
  // The player box in the template's own shape when the page knows it (a list it came from),
  // else 16:9 — the common case — so the page does not jump when the template arrives (review M3).
  const w = canvas?.width && canvas.width > 0 ? canvas.width : 16;
  const h = canvas?.height && canvas.height > 0 ? canvas.height : 9;
  return (
    <div data-testid="template-details-skeleton" className="mx-auto w-full max-w-6xl px-6 py-6" aria-hidden="true">
      <Skeleton className="h-4 w-24" />
      <div className="mt-4 grid gap-6 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Skeleton
          data-testid="template-details-skeleton-player"
          className="mx-auto w-full rounded-xl"
          style={{ aspectRatio: `${w} / ${h}`, maxHeight: "70vh", maxWidth: `calc(70vh * ${w / h})` }}
        />
        <div className="flex flex-col gap-3">
          <Skeleton className="h-7 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-full" />
          <div className="flex gap-2 pt-2">
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-8 w-20" />
          </div>
          <Skeleton className="mt-2 h-16 w-full rounded-lg" />
        </div>
      </div>
      <div className="mt-10 space-y-3">
        <Skeleton className="h-5 w-28" />
        <div className="space-y-2 rounded-xl border border-border p-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 flex-1" />
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-24" />
            </div>
          ))}
        </div>
      </div>
      <div className="mt-10 space-y-3">
        <Skeleton className="h-5 w-28" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
