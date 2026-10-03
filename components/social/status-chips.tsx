import { cn } from "@/lib/utils";
import { PlatformIcon } from "@/components/social/platform-icon";
import { isInboxTarget, postStatusLabel, postStatusTone, targetStatusLabel } from "@/lib/social/status-words";
import type { PostStatus, SocialPost, SocialTarget, TargetStatus } from "@/lib/social/types";

export const STATUS_STYLE: Record<PostStatus | "inbox", string> = {
  draft: "bg-muted text-muted-foreground",
  scheduled: "bg-blue-500/15 text-blue-400",
  publishing: "bg-amber-500/15 text-amber-400",
  published: "bg-emerald-500/15 text-emerald-400",
  // An inbox upload is not public: it is not the green of a published post.
  inbox: "bg-sky-500/15 text-sky-400",
  partial: "bg-orange-500/15 text-orange-400",
  failed: "bg-red-500/15 text-red-400",
  cancelled: "line-through text-muted-foreground",
};

const CHIP_BASE =
  "inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-4xl px-2 py-0.5 text-xs font-medium whitespace-nowrap";

/** The post's status in libi's words (`lib/social/status-words.ts`): an inbox upload says so instead of "Published". */
export function StatusChip({ post }: { post: Pick<SocialPost, "status" | "targets"> }) {
  const tone = postStatusTone(post);
  return (
    <span data-testid="status-chip" data-status={tone} className={cn(CHIP_BASE, STATUS_STYLE[tone])}>
      {postStatusLabel(post)}
    </span>
  );
}

const TARGET_STATUS_STYLE: Record<TargetStatus | "inbox", string> = {
  pending: "bg-muted text-muted-foreground",
  published: "bg-emerald-500/15 text-emerald-400",
  inbox: "bg-sky-500/15 text-sky-400",
  failed: "bg-red-500/15 text-red-400",
  cancelled: "line-through text-muted-foreground",
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
          className={cn(CHIP_BASE, TARGET_STATUS_STYLE[isInboxTarget(t) ? "inbox" : t.status])}
        >
          <PlatformIcon platform={t.platform} className="size-3" />
          <span>{targetStatusLabel(t)}</span>
        </span>
      ))}
    </span>
  );
}
