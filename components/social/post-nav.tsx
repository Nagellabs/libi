"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { PlatformIcon } from "@/components/social/platform-icon";
import type { PostStatus } from "@/lib/social/types";

/** One dot per status. Deliberately not `STATUS_STYLE`'s first class — that
 *  map's `cancelled` entry leads with `line-through`, which paints no dot at
 *  all, and a status that silently renders nothing is worse than no dot. */
const DOT: Record<PostStatus, string> = {
  draft: "bg-muted-foreground/50",
  scheduled: "bg-blue-400",
  publishing: "bg-amber-400",
  published: "bg-emerald-400",
  partial: "bg-orange-400",
  failed: "bg-red-400",
  cancelled: "bg-muted-foreground/30",
};

export interface PostNavItem {
  /** The post or ad id. The scrollable card carries it as its DOM `id` via `postAnchorId`. */
  id: string;
  /** "Instagram — Reel", "Meta Ads — Ad": the network and the type, which is
   *  what tells a piece's posts apart when the caption is the same on all of them. */
  label: string;
  /** For the glyph only — the posting platform, even for an ad (whose own
   *  network key is a different key space entirely). */
  platform: string;
  /** Absent for an ad: an ad has a delivery status, not a post status, and
   *  colouring one with the other's palette would be a lie. */
  status?: PostStatus;
  /** "Mon, 21 Sep" — whatever the row itself shows, or nothing. */
  when?: string | null;
}

/** The DOM id a card must carry for this nav to find and scroll to it. */
export function postAnchorId(id: string): string {
  return `post-anchor-${id}`;
}

/** The element that actually scrolls the cards — the editor tab's own
 *  `overflow-auto` pane, not the window. Walked rather than passed in,
 *  because this list has no idea which surface it was rendered onto. */
function scrollParent(el: Element | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const overflow = getComputedStyle(p).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/**
 * The list of this piece's posts, beside the posts themselves.
 *
 * Ten posts with their ads and analytics inline is several screens of
 * scrolling, and nothing said where you were in it (QA 2026-09-21). This is
 * the map: every post by network and type, the one you are looking at
 * highlighted, and a click jumps to any of them.
 *
 * The highlight follows the SCROLL, not a selection — which is why it is an
 * `IntersectionObserver` over the cards rather than state the list owns. A
 * browser without one (jsdom, and any headless render) simply gets the first
 * item highlighted and a working click; the list is never blank because the
 * observer is missing.
 */
export function PostNav({ items }: { items: PostNavItem[] }) {
  const [active, setActive] = useState<string | null>(null);

  // The id list as ONE string, so the observer is rebuilt when the list
  // actually changes rather than on every parent render — and so the
  // callback's ordering source lives inside the effect instead of in a ref
  // this component would have to touch during render (banned by this repo's
  // lint rule).
  const ids = items.map((i) => i.id).join(",");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const order = ids ? ids.split(",") : [];
    if (order.length === 0) return;
    const seen = new Set<string>();
    const container = scrollParent(document.getElementById(postAnchorId(order[0])));

    // ONE place decides, so the observer and the end-of-list rule can never
    // disagree about the same scroll position.
    const recompute = () => {
      // At the very bottom, the last card is what you are looking at — and it
      // is the one card that can NEVER reach the top band, because there is
      // nothing left to scroll. Without this, clicking the last entry scrolled
      // to it and then highlighted a different one (found live, 2026-09-21).
      if (container && container.scrollTop + container.clientHeight >= container.scrollHeight - 4) {
        setActive(order[order.length - 1]);
        return;
      }
      // Otherwise the topmost card still on screen. When a fast scroll leaves
      // none in the band, the last answer stands rather than flickering to
      // nothing.
      const next = order.find((id) => seen.has(id));
      if (next) setActive(next);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = e.target.getAttribute("data-nav-id");
          if (!id) continue;
          if (e.isIntersecting) seen.add(id);
          else seen.delete(id);
        }
        recompute();
      },
      // Only the top 40% of the viewport counts, so "active" means "at the
      // top of the screen" rather than "anywhere on it" — with tall cards,
      // three are visible at once and the bottom one is not what you are
      // looking at.
      { rootMargin: "0px 0px -60% 0px", threshold: 0 },
    );
    for (const id of order) {
      const el = document.getElementById(postAnchorId(id));
      if (el) observer.observe(el);
    }
    container?.addEventListener("scroll", recompute, { passive: true });
    return () => {
      observer.disconnect();
      container?.removeEventListener("scroll", recompute);
    };
  }, [ids]);

  const current = active && items.some((i) => i.id === active) ? active : (items[0]?.id ?? null);

  if (items.length === 0) return null;

  return (
    <nav aria-label="Posts in this piece" data-testid="post-nav" className="sticky top-0 self-start">
      <ul className="flex max-h-[calc(100vh-10rem)] flex-col gap-0.5 overflow-y-auto pr-1">
        {items.map((item) => {
          const isActive = item.id === current;
          return (
            <li key={item.id}>
              <button
                type="button"
                data-testid="post-nav-item"
                data-post-id={item.id}
                data-active={isActive ? "true" : undefined}
                aria-current={isActive ? "true" : undefined}
                onClick={() => {
                  setActive(item.id);
                  document.getElementById(postAnchorId(item.id))?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                className={cn(
                  "flex w-full cursor-pointer items-start gap-2 rounded-lg border-l-2 px-2 py-1.5 text-left transition-colors",
                  isActive
                    ? "border-primary bg-muted text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <PlatformIcon platform={item.platform} className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{item.label}</span>
                  {item.when && <span className="block truncate text-[0.65rem] text-muted-foreground">{item.when}</span>}
                </span>
                {item.status && (
                  <span
                    aria-hidden
                    data-status={item.status}
                    title={item.status}
                    className={cn("mt-1 size-1.5 shrink-0 rounded-full", DOT[item.status])}
                  />
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
