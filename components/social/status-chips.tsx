import { cn } from "@/lib/utils";
import { PlatformIcon } from "@/components/social/platform-icon";
import type { PostStatus, SocialTarget, TargetStatus } from "@/lib/social/types";

export const STATUS_STYLE: Record<PostStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  scheduled: "bg-blue-500/15 text-blue-400",
  publishing: "bg-amber-500/15 text-amber-400",
  published: "bg-emerald-500/15 text-emerald-400",
  partial: "bg-orange-500/15 text-orange-400",
  failed: "bg-red-500/15 text-red-400",
  cancelled: "line-through text-muted-foreground",
};

const STATUS_LABEL: Record<PostStatus, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  publishing: "Publishing",
  published: "Published",
  partial: "Partial",
  failed: "Failed",
  cancelled: "Cancelled",
};

const CHIP_BASE =
  "inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-4xl px-2 py-0.5 text-xs font-medium whitespace-nowrap";

export function StatusChip({ status }: { status: PostStatus }) {
  return (
    <span data-testid="status-chip" data-status={status} className={cn(CHIP_BASE, STATUS_STYLE[status])}>
      {STATUS_LABEL[status]}
    </span>
  );
}

const TARGET_STATUS_STYLE: Record<TargetStatus, string> = {
  pending: "bg-muted text-muted-foreground",
  published: "bg-emerald-500/15 text-emerald-400",
  failed: "bg-red-500/15 text-red-400",
  cancelled: "line-through text-muted-foreground",
};

const TARGET_STATUS_LABEL: Record<TargetStatus, string> = {
  pending: "Pending",
  published: "Published",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** One chip per target: a platform glyph + its own status word. A failed
 *  target's `title` carries the provider's verbatim `error` so it shows up
 *  on hover without a second component. */
export function TargetChips({ targets }: { targets: SocialTarget[] }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {targets.map((t) => (
        <span
          key={`${t.platform}:${t.accountId}`}
          data-testid="target-chip"
          data-platform={t.platform}
          data-status={t.status}
          title={t.error}
          className={cn(CHIP_BASE, TARGET_STATUS_STYLE[t.status])}
        >
          <PlatformIcon platform={t.platform} className="size-3" />
          <span>{TARGET_STATUS_LABEL[t.status]}</span>
        </span>
      ))}
    </span>
  );
}
