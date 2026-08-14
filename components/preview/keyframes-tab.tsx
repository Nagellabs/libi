// components/preview/keyframes-tab.tsx
"use client";

import type { Overlay } from "@/lib/engine/types";
import { overlayKeyframeTimes } from "@/lib/overlays/keyframes";
import { KeyframeList, AddKeyframeButton } from "@/components/preview/keyframe-list";
import { KeyframeCurveEditor } from "@/components/preview/keyframe-curve-editor";

interface KeyframesTabProps {
  pieceId: string;
  overlay: Overlay;
  fps: number;
  /** The selected keyframe's normalized time, or null. */
  selectedT: number | null;
  onSelect: (t: number) => void;
  /** Add a keyframe on this overlay at the live playhead (+ select it). */
  onAddKeyframeAtPlayhead: () => void;
  readOnly: boolean;
}

/**
 * The two-column Keyframes tab: LEFT = the keyframe list, RIGHT = the easing
 * curve editor for the selected keyframe. Renders an add-at-playhead prompt when
 * the overlay carries no keyframes yet.
 */
export function KeyframesTab({
  pieceId,
  overlay,
  fps,
  selectedT,
  onSelect,
  onAddKeyframeAtPlayhead,
  readOnly,
}: KeyframesTabProps) {
  const hasKeyframes = overlayKeyframeTimes(overlay).length > 0;

  if (!hasKeyframes) {
    return (
      <div className="flex flex-col items-center gap-3 py-6" data-testid="keyframes-empty">
        <p className="text-center text-xs text-muted-foreground">
          No keyframes yet — add one at the playhead to start animating this layer.
        </p>
        {!readOnly && <AddKeyframeButton onClick={onAddKeyframeAtPlayhead} />}
      </div>
    );
  }

  return (
    <div
      data-testid="keyframes-tab"
      className="grid min-h-0 flex-1 gap-3"
      style={{ gridTemplateColumns: "minmax(0, 0.85fr) minmax(0, 1fr)" }}
    >
      <KeyframeList
        pieceId={pieceId}
        overlay={overlay}
        fps={fps}
        selectedT={selectedT}
        onSelect={onSelect}
        onAddKeyframeAtPlayhead={onAddKeyframeAtPlayhead}
        readOnly={readOnly}
      />
      {selectedT !== null ? (
        <KeyframeCurveEditor
          pieceId={pieceId}
          overlay={overlay}
          t={selectedT}
          fps={fps}
          readOnly={readOnly}
        />
      ) : (
        <p
          className="flex items-center justify-center px-2 text-center text-[11px] text-muted-foreground"
          data-testid="keyframes-select-prompt"
        >
          Select a keyframe to shape its easing.
        </p>
      )}
    </div>
  );
}
