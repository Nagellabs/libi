import { Skeleton } from "@/components/ui/skeleton";

export function SkillDetailSkeleton() {
  return (
    <div className="mx-auto w-full max-w-5xl p-6">
      <Skeleton className="mb-2 h-4 w-24" />
      <Skeleton className="mb-6 h-7 w-64" />
      <div className="grid grid-cols-[200px_1fr] gap-6">
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
        <div className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    </div>
  );
}
