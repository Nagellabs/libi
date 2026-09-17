"use client";

import { Badge } from "@/components/ui/badge";

interface TagFilterProps {
  allTags: string[];
  selected: string[];
  onToggle: (tag: string) => void;
}

export function TagFilter({ allTags, selected, onToggle }: TagFilterProps) {
  if (allTags.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {allTags.map((tag) => {
        const active = selected.includes(tag);
        return (
          <button key={tag} type="button" onClick={() => onToggle(tag)} aria-pressed={active} className="cursor-pointer">
            <Badge variant={active ? "default" : "outline"} className={active ? "" : "text-muted-foreground"}>
              {tag}
            </Badge>
          </button>
        );
      })}
    </div>
  );
}
