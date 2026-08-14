import { Skeleton } from "@/components/ui/skeleton";

interface Props {
  count?: number;
}

export function AssetGridSkeleton({ count = 8 }: Props) {
  return (
    <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          data-testid="asset-grid-skeleton-tile"
          className="flex flex-col gap-1.5"
        >
          <Skeleton className="aspect-video w-full rounded-md" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      ))}
    </div>
  );
}
