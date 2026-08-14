"use client";

import { useState } from "react";
import { PlusIcon } from "lucide-react";
import type { StoryboardCard, GeneratedClip } from "@/lib/storyboard/types";
import { visibleTakes } from "@/lib/storyboard/take-view";
import { MediaTile } from "./media-tile";
import { MediaViewer } from "@/components/storyboard/media-viewer";

interface GeneratedTakesRowProps {
  pieceId: string;
  card: StoryboardCard;
  onSelectTake?: (takeId: string) => void;
  onHideTake?: (takeId: string) => void;
  onPrefill?: (text: string) => void;
}

export function GeneratedTakesRow({
  pieceId: _pieceId,
  card,
  onSelectTake,
  onHideTake,
  onPrefill,
}: GeneratedTakesRowProps) {
  const takes = visibleTakes(card);
  const [viewerTake, setViewerTake] = useState<GeneratedClip | null>(null);

  if (takes.length === 0) return null;

  return (
    <div>
      {/* Group label */}
      <div className="text-[11px] text-muted-foreground mb-1.5">
        Generated · {takes.length} take{takes.length === 1 ? "" : "s"}
      </div>

      {/* Tiles */}
      <div className="flex flex-wrap items-start gap-3">
        {takes.map((take) => (
          <MediaTile
            key={take.id}
            kind="video"
            width={62}
            src={`/api/files/by-id/${take.fileId}/content`}
            label={take.label}
            selected={take.id === card.selectedClipId}
            onView={() => setViewerTake(take)}
            onRemove={onHideTake ? () => onHideTake(take.id) : undefined}
          />
        ))}

        {/* Trailing "new" tile */}
        {onPrefill && (
          <div style={{ width: 62 }}>
            <button
              type="button"
              onClick={() =>
                onPrefill(
                  `Generate another take for scene "${card.title}" (card ${card.id}).`,
                )
              }
              className="cursor-pointer aspect-[9/16] w-full rounded-md border border-dashed border-border flex flex-col items-center justify-center gap-1 text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground/70 transition-colors"
              aria-label="Generate new take"
            >
              <PlusIcon className="size-3.5" />
            </button>
            <div className="mt-0.5 text-[10px] text-muted-foreground text-center">new</div>
          </div>
        )}
      </div>

      {/* Viewer — plays the take + lets you put it on the timeline */}
      <MediaViewer
        open={!!viewerTake}
        onOpenChange={(o) => !o && setViewerTake(null)}
        src={viewerTake ? `/api/files/by-id/${viewerTake.fileId}/content` : undefined}
        kind="video"
        title={viewerTake ? `Take ${viewerTake.label} — ${card.title}` : undefined}
        footer={
          viewerTake && onSelectTake ? (
            viewerTake.id === card.selectedClipId ? (
              <span className="text-[12px] text-blue-400">On the timeline</span>
            ) : (
              <button
                type="button"
                onClick={() => {
                  onSelectTake(viewerTake.id);
                  setViewerTake(null);
                }}
                className="cursor-pointer rounded-md bg-blue-500 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-blue-600"
              >
                Use on timeline
              </button>
            )
          ) : undefined
        }
      />
    </div>
  );
}
