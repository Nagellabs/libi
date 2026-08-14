"use client";

import { useEffect, useState, type RefObject } from "react";
import { cn } from "@/lib/utils";
import type { DocSectionLink } from "@/lib/instructions/toc";

interface Props {
  sections: DocSectionLink[];
  /** The scrollable content container holding the rendered markdown. */
  scrollRef: RefObject<HTMLElement | null>;
}

export function DocToc({ sections, scrollRef }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || sections.length === 0) return;

    const onScroll = () => {
      // Query fresh on every tick — a markdown re-render can replace the
      // heading nodes, and stale element references report rect (0,0).
      const headings = Array.from(root.querySelectorAll<HTMLElement>("[data-doc-section]"));
      if (headings.length === 0) return;
      const top = root.getBoundingClientRect().top;
      let current: string | null = headings[0]?.id ?? null;
      for (const h of headings) {
        if (h.getBoundingClientRect().top - top <= 32) current = h.id;
        else break;
      }
      setActiveId(current);
    };
    onScroll();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, [scrollRef, sections]);

  if (sections.length === 0) return null;

  return (
    <nav className="space-y-0.5">
      {sections.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => {
            setActiveId(s.id);
            const root = scrollRef.current;
            const el = root?.querySelector<HTMLElement>(`#${CSS.escape(s.id)}`);
            el?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
          className={cn(
            "block w-full cursor-pointer truncate rounded px-2 py-1 text-left text-xs transition-colors",
            activeId === s.id
              ? "bg-accent font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {s.title}
        </button>
      ))}
    </nav>
  );
}
