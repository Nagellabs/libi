import type { StoryboardCard, SketchRole } from "./types";

export type SketchSlotView = {
  slotId: string;
  role: SketchRole;
  paramKey: string;
  /** Display label under the tiles. */
  label: string;
  /** The slot has a sketch to show (a render unit OR an imported image). */
  hasSketch: boolean;
  /** An imported image used AS the sketch (overrides the rendered unit src). */
  sketchImageFileId?: string;
  /** The realized image fileId from clipGen.params[paramKey], if set. */
  imageFileId?: string;
};

const ROLE_RANK: Record<SketchRole, number> = { start: 0, end: 1, reference: 2 };
const ROLE_LABEL: Record<SketchRole, string> = {
  start: "start keyframe",
  end: "end keyframe",
  reference: "reference",
};

/** Pure: ordered (start → end → references) slot views with the realized image
 *  joined from the card's clip-gen params by paramKey. */
export function sketchSlotViews(card: StoryboardCard): SketchSlotView[] {
  const params = card.clipGen?.params ?? {};
  return [...card.sketches]
    .sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role])
    .map((s) => {
      const v = params[s.paramKey];
      return {
        slotId: s.id,
        role: s.role,
        paramKey: s.paramKey,
        label: s.label ?? ROLE_LABEL[s.role],
        hasSketch: !!s.render || !!s.imageFileId,
        sketchImageFileId: s.imageFileId,
        imageFileId: typeof v === "string" && v ? v : undefined,
      };
    });
}

/** Partition for rendering: slots with a realized image each get their own
 *  [sketch|image] row; image-less slots share one wrapping sketch row. Order is
 *  preserved (start → end → references). */
export function partitionSketchRows(views: SketchSlotView[]): {
  pairedRows: SketchSlotView[];
  sketchOnlyRow: SketchSlotView[];
} {
  const pairedRows: SketchSlotView[] = [];
  const sketchOnlyRow: SketchSlotView[] = [];
  for (const v of views) {
    if (v.imageFileId) pairedRows.push(v);
    else sketchOnlyRow.push(v);
  }
  return { pairedRows, sketchOnlyRow };
}
