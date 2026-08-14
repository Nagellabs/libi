import { Skeleton } from "@/components/ui/skeleton";

export function EditorSkeleton() {
  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Chat panel skeleton */}
      <div className="flex w-[35%] min-w-0 flex-col border-r border-border">
        {/* Chat messages area */}
        <div className="flex-1 space-y-4 p-4">
          {/* Incoming message */}
          <div className="flex gap-2">
            <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-64" />
            </div>
          </div>
          {/* Outgoing message */}
          <div className="flex justify-end">
            <Skeleton className="h-10 w-52 rounded-lg" />
          </div>
          {/* Incoming message */}
          <div className="flex gap-2">
            <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-32" />
            </div>
          </div>
        </div>
        {/* Input area */}
        <div className="border-t border-border p-4">
          <Skeleton className="h-10 w-full rounded-md" />
        </div>
      </div>

      {/* Preview + Timeline skeleton */}
      <div className="flex w-[65%] min-w-0 flex-col">
        {/* Preview area */}
        <div className="flex flex-1 min-h-0 items-center justify-center bg-background p-4">
          <Skeleton className="aspect-video w-full max-w-2xl rounded-lg" />
        </div>
        {/* Timeline */}
        <div className="shrink-0 border-t border-border p-3">
          <Skeleton className="h-8 w-full rounded-md" />
        </div>
      </div>
    </div>
  );
}
