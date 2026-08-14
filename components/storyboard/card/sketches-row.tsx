"use client";

import { useState } from "react";
import type { StoryboardCard, GenParamValue } from "@/lib/storyboard/types";
import { sketchSlotViews, partitionSketchRows, type SketchSlotView } from "@/lib/storyboard/sketch-row-view";
import { MediaTile } from "./media-tile";
import { MediaViewer } from "@/components/storyboard/media-viewer";

interface SketchesRowProps {
  pieceId: string;
  card: StoryboardCard;
  onEditParam?: (key: string, value: GenParamValue | null) => void;
}

/** Shared gap between every item on a row — sketches, images, videos, audio all
 *  use this so the spacing reads evenly across the card. */
export const ROW_GAP = "gap-3";

function sketchUrl(pieceId: string, cardId: string, slotId: string) {
  return `/api/pieces/${pieceId}/storyboard/cards/${cardId}/sketches/${slotId}`;
}

export function SketchesRow({ pieceId, card, onEditParam }: SketchesRowProps) {
  const [viewer, setViewer] = useState<{ src: string; title: string } | null>(null);
  const views = sketchSlotViews(card);
  if (views.length === 0) return null;
  const { pairedRows, sketchOnlyRow } = partitionSketchRows(views);
  const editable = !!onEditParam;

  // Plain render helpers — called as functions, NOT JSX elements, so React doesn't
  // remount their subtrees on every render.
  const sketchTile = (v: SketchSlotView) => {
    if (!v.hasSketch) return null;
    // An imported image (sketchImageFileId) is served directly; otherwise the
    // per-slot serve route renders the unit.
    const src = v.sketchImageFileId
      ? `/api/files/by-id/${v.sketchImageFileId}/content`
      : sketchUrl(pieceId, card.id, v.slotId);
    return (
      <MediaTile
        kind="image"
        width={64}
        src={src}
        label={v.label}
        onView={() => setViewer({ src, title: `${v.label} — sketch` })}
      />
    );
  };

  // Only rendered for paired slots (imageFileId is always set here).
  const imageTile = (v: SketchSlotView) =>
    v.imageFileId ? (
      <MediaTile
        kind="image"
        width={64}
        src={`/api/files/by-id/${v.imageFileId}/content`}
        label="image"
        onView={() => setViewer({ src: `/api/files/by-id/${v.imageFileId}/content`, title: `${v.label} — image` })}
        onRemove={editable ? () => onEditParam!(v.paramKey, null) : undefined}
      />
    ) : null;

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] text-muted-foreground">Sketches</span>
      </div>

      <div className="flex flex-col gap-3">
        {sketchOnlyRow.length > 0 && (
          <div className={`flex flex-wrap items-start ${ROW_GAP}`}>
            {sketchOnlyRow.map((v) => (
              <div key={v.slotId}>{sketchTile(v)}</div>
            ))}
          </div>
        )}

        {pairedRows.map((v) => (
          <div key={v.slotId} className={`flex items-start ${ROW_GAP}`}>
            {sketchTile(v)}
            {imageTile(v)}
          </div>
        ))}
      </div>

      <MediaViewer
        open={!!viewer}
        onOpenChange={(o) => !o && setViewer(null)}
        src={viewer?.src}
        kind="image"
        title={viewer?.title}
      />
    </div>
  );
}
