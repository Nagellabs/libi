"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { type LinkedPost, useSocialStatus } from "@/lib/queries/social";
import { captionFirstLine, isStoryOnly, postEntryLabel, whenLabel } from "@/lib/social/format";
import { StatusChip, TargetChips } from "@/components/social/status-chips";
import { PlatformIcon } from "@/components/social/platform-icon";
import { PostActions } from "@/components/social/post-actions";

const CREATED_BY_LABEL: Record<"agent" | "ui", string> = { agent: "by agent", ui: "in libi" };

/**
 * One post, as a card.
 *
 * ONE post is ONE card, and everything that belongs to it — the ads that
 * boost it, its analytics — is drawn INSIDE that card under a divider
 * (`children`), not as sibling blocks beside it. Stacked as siblings, ten
 * posts read as thirty unrelated panels and nobody could tell where one post
 * ended and the next began (QA 2026-09-21).
 */
export function PostRow({
  post,
  onOpen,
  onEdit,
  showPiece = false,
  anchorId,
  children,
}: {
  post: LinkedPost;
  onOpen: (id: string) => void;
  /** Opens this post in the composer. Only where a composer exists to open —
   *  the Social page passes nothing and the Edit button does not render. */
  onEdit?: (id: string) => void;
  showPiece?: boolean;
  /** A DOM id for the card, so a list beside it can scroll to and highlight
   *  this post (`components/social/post-nav.tsx`). */
  anchorId?: string;
  /** Drawn inside the same card, below a divider: this post's ads and analytics. */
  children?: ReactNode;
}) {
  const status = useSocialStatus();
  const tz = status.data?.settings.timezone ?? null;
  const media = post.media[0];
  const when = whenLabel(post, tz);
  const createdBy = post.link?.createdBy ? CREATED_BY_LABEL[post.link.createdBy] : null;

  return (
    <li
      data-testid="post-row"
      data-post-id={post.id}
      id={anchorId}
      data-nav-id={anchorId ? post.id : undefined}
      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >
      {/* A filled header band, because the card's own `bg-card` is the SAME
          colour as the editor panel behind it (`--card` and `--surface` are
          both #1c1f22): a 1px border was the only thing separating one post
          from the next, and ten posts read as one wall of text (QA
          2026-09-21). A band that names the post is what makes the boundary
          visible on any ground, without inventing a colour. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-muted px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {/* The network and the type — the one thing that told a piece's
              posts apart and was visible nowhere: the target chips carry
              platform and status, never Reel vs Story vs Feed. */}
          <PlatformIcon platform={post.targets[0]?.platform ?? ""} className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-semibold uppercase tracking-wide" data-testid="post-row-kind">
            {postEntryLabel(post)}
          </span>
        </div>
        <StatusChip status={post.status} />
        {when && <span className="text-xs text-muted-foreground">{when}</span>}
        <div className="ml-auto">
          <PostActions post={post} compact onEdit={onEdit ? () => onEdit(post.id) : undefined} />
        </div>
      </div>

      {/* `flex-wrap` plus a basis on the middle column is what keeps this row
          honest in a narrow panel (QA 2026-09-21, finding 10). */}
      <div className="flex flex-wrap items-center gap-3 p-3">
        <button
          type="button"
          onClick={() => onOpen(post.id)}
          className="shrink-0 cursor-pointer overflow-hidden rounded-md"
          aria-label="Open post"
        >
          {media ? (
            media.type === "video" ? (
              <video muted preload="metadata" src={media.url} className="size-12 rounded-md object-cover" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- thumbnail source is a remote/provider URL, not a static asset
              <img src={media.url} alt="" className="size-12 rounded-md object-cover" />
            )
          ) : (
            <div className="size-12 rounded-md bg-muted" />
          )}
        </button>

        <div className="min-w-0 flex-1 basis-56">
          <button
            type="button"
            onClick={() => onOpen(post.id)}
            className="block w-full cursor-pointer truncate text-left text-sm font-medium hover:underline"
          >
            {/* Three cases, and the third used to render as a blank line the
                user could click but not see: a Story needs no caption, a
                post HAS one, and a draft may simply not have been written
                yet. Say which. */}
            {isStoryOnly(post) ? (
              <span className="italic text-muted-foreground">Story — no caption</span>
            ) : captionFirstLine(post.content) ? (
              captionFirstLine(post.content)
            ) : (
              <span className="italic text-muted-foreground">No caption yet</span>
            )}
          </button>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <TargetChips targets={post.targets} />
            {createdBy && <span>{createdBy}</span>}
            {showPiece && post.libi && (
              // `?piece=` is the deep-link the editor page reads on mount to
              // open a specific piece (and land on its Posting tab) instead of
              // whatever piece happened to be open last — see
              // app/(app)/editor/page.tsx's deep-link restore effect.
              <Link href={`/editor?piece=${encodeURIComponent(post.libi.pieceId)}`} className="cursor-pointer text-primary hover:underline">
                {post.libi.pieceName ?? "Piece"}
              </Link>
            )}
          </div>
        </div>
      </div>

      {children && (
        <div className="space-y-3 border-t border-border bg-background/60 p-3" data-testid="post-row-detail">
          {children}
        </div>
      )}
    </li>
  );
}
