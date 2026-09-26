"use client";

import Link from "next/link";
import { Clapperboard } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { PlatformIcon } from "@/components/social/platform-icon";
import { platformLabel } from "@/lib/social/catalog";
import type { SocialTarget } from "@/lib/social/types";

const LINK_BUTTON =
  "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-background px-2 text-[0.8rem] font-medium hover:bg-muted";

/**
 * Where a post lives on each network, as that network's own mark.
 *
 * These were buttons that all said "Open" — on a post that went to three
 * networks, three identical words, and nothing to say that clicking one
 * LEAVES libi for the platform (QA 2026-09-22). The mark says both: which
 * network, and that it is the network's page you are going to.
 */
export function PlatformOpenLinks({ targets }: { targets: SocialTarget[] }) {
  const live = targets.filter((t) => t.url);
  if (live.length === 0) return null;
  return (
    <TooltipProvider>
      {live.map((t) => {
        const name = platformLabel(t.platform);
        return (
          <Tooltip key={`${t.platform}:${t.accountId}`}>
            <TooltipTrigger
              render={
                <a
                  href={t.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="post-action-open"
                  data-platform={t.platform}
                  aria-label={`Open on ${name}`}
                  className={`${LINK_BUTTON} w-7 justify-center px-0`}
                />
              }
            >
              <PlatformIcon platform={t.platform} className="size-3.5" />
            </TooltipTrigger>
            {/* Instagram and TikTok have no unpublish — the one thing worth
                knowing before you go there to "undo" a post. */}
            <TooltipContent>
              Open on {name}
              {t.platform === "instagram" || t.platform === "tiktok" ? ` — remove it there; ${name} has no unpublish` : ""}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </TooltipProvider>
  );
}

/** The editor, on this piece's Posting tab, narrowed to the one post (or ad)
 *  this came from — `app/(app)/editor/page.tsx` reads `?piece=` + `?post=`. */
export function pieceHref(pieceId: string, focusId?: string): string {
  const q = new URLSearchParams({ piece: pieceId });
  if (focusId) q.set("post", focusId);
  return `/editor?${q.toString()}`;
}

/** "Piece": back to where this was made, on the post itself. */
export function PieceLink({ pieceId, pieceName, focusId }: { pieceId: string; pieceName?: string; focusId?: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={<Link href={pieceHref(pieceId, focusId)} data-testid="post-piece-link" className={LINK_BUTTON} />}
        >
          <Clapperboard className="size-3.5" />
          Piece
        </TooltipTrigger>
        <TooltipContent>{pieceName ? `Open “${pieceName}” on its Posting tab` : "Open the piece on its Posting tab"}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
