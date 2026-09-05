"use client";

import { useState } from "react";
import type { StoryboardCard, GenParamValue } from "@/lib/storyboard/types";
import { sketchSlotViews, partitionSketchRows, type SketchSlotView } from "@/lib/storyboard/sketch-row-view";
import { MediaTile } from "./media-tile";
import { MediaViewer } from "@/components/storyboard/media-viewer";

interface SketchesRowProps {
  pieceId: string;
  card: StoryboardCard;
  /** slotId → a content hash of the sketch PNG's bytes, so a re-rendered
   *  drawing gets a changed `src` and the browser actually re-requests it
   *  (see sketchUrl below). */
  sketchRevs?: Record<string, string>;
  onEditParam?: (key: string, value: GenParamValue | null) => void;
}

/** Shared gap between every item on a row — sketches, images, videos, audio all
 *  use this so the spacing reads evenly across the card. */
export const ROW_GAP = "gap-3";

/** The sketch PNG is regenerated IN PLACE at an otherwise-invariant URL, so a
 *  mounted <img> never re-requests it on its own — the `rev` (a content hash
 *  of the file's bytes) is appended as a query param specifically to change
 *  the `src` when the drawing actually changes. Omitted when no revision is
 *  known yet (falsy, e.g. ""), so the URL matches what the slot GET route
 *  lazy-renders on first request. */
export function sketchUrl(pieceId: string, cardId: string, slotId: string, rev?: string) {
  const base = `/api/pieces/${pieceId}/storyboard/cards/${cardId}/sketches/${slotId}`;
  return rev ? `${base}?v=${rev}` : base;
}

export function SketchesRow({ pieceId, card, sketchRevs, onEditParam }: SketchesRowProps) {
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
      : sketchUrl(pieceId, card.id, v.slotId, sketchRevs?.[v.slotId]);
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
