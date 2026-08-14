"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { StoryboardCard as Card } from "@/lib/storyboard/types";
import type { SchemasMap } from "@/lib/queries/storyboard";
import { StoryboardCard } from "./storyboard-card";

interface StoryboardListViewProps {
  pieceId: string;
  /** Cards pre-sorted by `order`. */
  cards: Card[];
  schemas: SchemasMap;
  orderByCardId: Record<string, number>;
}

/** Show the scene-nav sidebar only once a list is long enough to be hard to
 *  scan by scrolling. */
const NAV_THRESHOLD = 2;

/**
 * List view of the storyboard. With more than {@link NAV_THRESHOLD} scenes it
 * gains a left sidebar that lists every scene in order — click to jump, and the
 * active scene highlights as you scroll (scroll-spy).
 */
export function StoryboardListView({
  pieceId,
  cards,
  schemas,
  orderByCardId,
}: StoryboardListViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [activeId, setActiveId] = useState<string | null>(cards[0]?.id ?? null);

  const showNav = cards.length > NAV_THRESHOLD;

  // Scroll-spy: highlight the topmost scene currently in view.
  useEffect(() => {
    if (!showNav) return;
    const root = scrollRef.current;
    if (!root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const id = visible[0]?.target.getAttribute("data-scene-id");
        if (id) setActiveId(id);
      },
      // Bias toward the top of the viewport so the active item tracks what the
      // user is reading, not what's merely peeking in at the bottom.
      { root, rootMargin: "0px 0px -70% 0px", threshold: 0 },
    );

    for (const c of cards) {
      const el = cardRefs.current[c.id];
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [cards, showNav]);

  function jumpTo(id: string) {
    setActiveId(id);
    cardRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const list = (
    <div
      ref={scrollRef}
      className="flex flex-1 min-h-0 flex-col gap-3 overflow-auto p-3"
    >
      {cards.map((c, i) => (
        <div
          key={c.id}
          data-scene-id={c.id}
          ref={(el) => {
            cardRefs.current[c.id] = el;
          }}
          className="scroll-mt-3"
        >
          <StoryboardCard
            pieceId={pieceId}
            card={c}
            index={i}
            schemas={schemas}
            orderByCardId={orderByCardId}
          />
        </div>
      ))}
    </div>
  );

  if (!showNav) return list;

  return (
    <div className="flex flex-1 min-h-0">
      <nav className="w-44 shrink-0 overflow-auto border-r border-border p-2">
        <div className="px-1.5 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Scenes
        </div>
        <ul className="flex flex-col gap-0.5">
          {cards.map((c, i) => {
            const active = c.id === activeId;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => jumpTo(c.id)}
                  className={cn(
                    "flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                    active
                      ? "bg-primary/10 text-foreground ring-1 ring-primary/30"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "mt-px shrink-0 text-[10px] font-semibold tabular-nums",
                      active ? "text-primary" : "text-muted-foreground/70",
                    )}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="line-clamp-2 leading-tight">
                    {c.title || `Scene ${i + 1}`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      {list}
    </div>
  );
}
