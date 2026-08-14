"use client";

import type { TrackedOverlay } from "@/lib/engine/types";
import type { InspectorGroup } from "@/lib/overlays/inspector-fields";
import { useTrack, useTrackAnchorActions } from "@/lib/queries/tracks";
import { ManualEditsPanel } from "@/components/preview/manual-edits-panel";
import { GroupField } from "@/components/preview/group-field";

/**
 * The tracked inspector's "Anchors" tab — the manual re-anchor LIST +
 * management (jump / staged delete / re-track), relocated from the old bottom
 * ManualEditsPanel. Behavior is unchanged: same presentational panel, same
 * REST endpoints, same track-query invalidation. The drag-to-re-anchor
 * GESTURE stays on the preview canvas ("Adjust tracking") — the hint below
 * teaches the split. Gated to the anchors tab by the GroupField wrapper
 * (its single registry key is `trackAnchors`).
 */
export function TrackedAnchorsTab({
  overlay,
  pieceId,
  mode,
  onSeekSeconds,
}: {
  overlay: TrackedOverlay;
  pieceId: string;
  mode: InspectorGroup;
  onSeekSeconds?: (t: number) => void;
}) {
  const { data: track } = useTrack(overlay.trackId);
  const { applyDeletes, retrack } = useTrackAnchorActions(pieceId, overlay.trackId);
  const anchors = track?.manualAnchors ?? [];
  return (
    <GroupField fieldKey="trackAnchors" kind="tracked" group={mode}>
      <div className="flex flex-col gap-2" data-testid="tracked-anchors-tab">
        <p className="text-[11px] text-muted-foreground">
          Corrections pinned to this overlay&apos;s track. Add one by turning on{" "}
          <span className="text-foreground/90">Adjust tracking</span> above the
          preview and dragging the overlay onto the right subject.
        </p>
        <ManualEditsPanel
          anchors={anchors}
          scopeLabel={
            overlay.content.kind === "emoji" ? overlay.content.char : overlay.content.kind
          }
          onJump={(t) => onSeekSeconds?.(t)}
          onApplyDeletes={applyDeletes}
          onRetrack={retrack}
        />
      </div>
    </GroupField>
  );
}
