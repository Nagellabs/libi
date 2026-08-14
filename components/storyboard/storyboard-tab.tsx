"use client";

import { useState } from "react";
import { Network, Rows3 } from "lucide-react";
import { useStoryboard, type SchemasMap } from "@/lib/queries/storyboard";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { BoardView } from "./board-view";
import { StoryboardListView } from "./list-view";
import { StoryboardSkeleton } from "@/components/skeletons/storyboard-skeleton";

type View = "board" | "list";

const VIEWS: { id: View; label: string; Icon: typeof Network; tip: string }[] = [
  { id: "board", label: "Board", Icon: Network, tip: "Board — a spatial canvas of scene cards you can pan, zoom, and drag." },
  { id: "list", label: "List", Icon: Rows3, tip: "List — every scene stacked top-to-bottom with its full details." },
];

export function StoryboardTab({ pieceId }: { pieceId: string }) {
  const { data, isLoading } = useStoryboard(pieceId);
  const sb = data?.storyboard ?? null;
  const schemas: SchemasMap = data?.schemas ?? {};
  const [view, setView] = useState<View>("board");

  if (isLoading) {
    return <StoryboardSkeleton />;
  }
  if (!sb || sb.cards.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        No storyboard yet. Ask the agent to draft one.
      </div>
    );
  }
  const cards = [...sb.cards].sort((a, b) => a.order - b.order);
  return (
    // h-full (not just flex-1): the editor tabpanel hosting this is a
    // block/overflow-auto container, so flex-1 never resolves a height — which
    // collapsed the Board view (React Flow needs an explicitly-sized parent) to
    // 0px. Filling the tabpanel + making the list a flex-1 min-h-0 scroll area
    // fixes Board while keeping List scrolling internally.
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border p-2">
        <TooltipProvider delay={200}>
          <div
            role="tablist"
            aria-label="Storyboard view"
            className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted/30 p-0.5"
          >
            {VIEWS.map(({ id, label, Icon, tip }) => {
              const active = view === id;
              return (
                <Tooltip key={id}>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => setView(id)}
                        className={cn(
                          "flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                          active
                            ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      />
                    }
                  >
                    <Icon className={cn("size-3.5", active ? "text-primary" : "")} />
                    {label}
                  </TooltipTrigger>
                  <TooltipContent>{tip}</TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </TooltipProvider>
      </div>
      {view === "board" ? (
        <div className="flex-1 min-h-0">
          <BoardView pieceId={pieceId} storyboard={sb} schemas={schemas} />
        </div>
      ) : (
        (() => {
          const orderByCardId = Object.fromEntries(cards.map((c) => [c.id, c.order]));
          return (
            <StoryboardListView
              pieceId={pieceId}
              cards={cards}
              schemas={schemas}
              orderByCardId={orderByCardId}
            />
          );
        })()
      )}
    </div>
  );
}
