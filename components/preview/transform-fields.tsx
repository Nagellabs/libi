"use client";

import type { Overlay, Transform3D } from "@/lib/engine/types";
import type { CaptionAnchor } from "@/lib/captions/types";
import type { OverlayTransformPatch } from "@/hooks/editor/use-overlay-transform-commit";
import { NumberSlider } from "@/components/preview/number-slider";
import { AnchorPad } from "@/components/preview/anchor-pad";
import { SizeField } from "@/components/preview/size-field";
import { regionCenterPoint, placeBoxAtAnchor } from "@/lib/captions/anchor";
import { defaultAnchorForKind } from "@/lib/overlays/anchor-default";
import {
  trackedScaleFromSizePct,
  trackedSizeFloorScale,
  trackedSizePctFromScale,
  TRACKED_SCALE_MAX,
} from "@/lib/preview/tracked-handle-math";


// ---------------------------------------------------------------------------
// Pure value mappers (exported for tests — no React dependency)
// ---------------------------------------------------------------------------

const RAD = Math.PI / 180;

export interface TransformUi {
  posX: number;
  posY: number;
  posZ: number;
  angle: number;
  elevation: number;
  spin: number;
}

export function transformToUi(t: Transform3D): TransformUi {
  return {
    posX: t.position.x,
    posY: t.position.y,
    posZ: t.position.z,
    angle: Math.round((t.rotation.y / RAD) * 100) / 100,
    elevation: Math.round((t.rotation.x / RAD) * 100) / 100,
    spin: Math.round((t.rotation.z / RAD) * 100) / 100,
  };
}

export function uiToTransform(u: TransformUi): Transform3D {
  return {
    position: { x: u.posX, y: u.posY, z: u.posZ },
    rotation: { x: u.elevation * RAD, y: u.angle * RAD, z: u.spin * RAD },
  };
}

// ---------------------------------------------------------------------------
// React component
// ---------------------------------------------------------------------------

/**
 * Shared PLANAR (2D) Transform panel — the always-on top group for every flat
 * NON-text overlay kind's inspector (image / video / code). It now uses the
 * SAME shared controls the text caption inspector uses:
 *
 *  - `<AnchorPad>` — a 3×3 canvas-anchor picker. Clicking a cell snaps the
 *    overlay's rect to that region of the canvas (mirrors caption-inspector's
 *    `placeAtCanvasAnchor`: persists `anchor` + `position` + the derived `rect`).
 *  - Position **X** / **Y** `<NumberSlider>`s — reference the anchor POINT of
 *    the rect (`anchorPointOf`). Editing re-pins the box via `placeBoxAtAnchor`
 *    so the preview moves instantly (commits `position` + the derived `rect`).
 *  - `<SizeField sizeMode="box">` — width/height with the shared split memory
 *    (`getOverlaySizeSplit` / `setOverlaySizeSplit` from editor-state).
 *  - **Spin** `<NumberSlider>` — in-plane rotation (`transform3d.rotation.z`),
 *    unchanged from the old behaviour (writes via `onPatch({ transform3d })`).
 *
 * The out-of-plane spatial controls (Angle / Elevation / Depth-Z) live in the
 * gated 3D panel (`ThreeDFields`).
 *
 * TRACKED overlays are the kind-aware exception: their placement is
 * track-driven (`resolveTrackedRect` never reads `rect.x/y`), so the Position
 * sliders + AnchorPad don't render, and their **Size** control reads/writes the
 * uniform `scale` multiplier — the SAME field the preview corner handles write
 * (`trackedScaleFromDrag`) — shown as a percent, clamped to the same bounds.
 *
 * Commit contract: `onPatch` is the SAME full `OverlayTransformPatch` commit the
 * panel passes (it forwards to `onCommit(overlay.id, …)`). Discrete edits
 * (anchor click, slider release) flush promptly via `onCommitEnd`. The
 * `data-field` markers (`transformPosX/Y`, `transformSpin`, `transformSize`)
 * are preserved so the inspector-fields coverage parity holds.
 */
export function TransformFields({
  overlay,
  frame = { width: 1920, height: 1080 },
  sizeSplit,
  onToggleSizeSplit,
  onPatch,
  onCommitEnd,
}: {
  overlay: Overlay;
  /** Composition pixel dimensions — drives the Position slider ranges + the
   *  anchor pad's canvas-relative placement. */
  frame?: { width: number; height: number };
  /** Per-overlay W/H split state (from editor-state, threaded by the panel). */
  sizeSplit: boolean;
  /** Persist the per-overlay W/H split toggle. */
  onToggleSizeSplit: (split: boolean) => void;
  /**
   * Apply a patch (rect / anchor / position / transform3d). The panel forwards
   * this to `onCommit(overlay.id, patch)` — the shared edit store paints
   * instantly.
   */
  onPatch: (patch: OverlayTransformPatch) => void;
  /**
   * Fired when an edit ENDS (anchor click, slider release / number blur) — the
   * inspector flushes the debounced PATCH so the change persists promptly.
   */
  onCommitEnd?: () => void;
}) {
  const rect = overlay.rect;
  // Tracked overlays: position is track-driven and Size is the `scale`
  // multiplier — narrow once so the tracked branch below is fully typed.
  const tracked = overlay.kind === "tracked" ? overlay : null;
  // `anchor` lives on BaseOverlay (shared by every overlay kind), so this read
  // needs no cast. Read it back optimistically for box overlays so a re-anchor
  // sticks across re-renders. Defaults to the kind's canvas anchor.
  const anchor: CaptionAnchor = overlay.anchor ?? defaultAnchorForKind(overlay.kind);

  // Spin (in-plane rotation.z) reads through the shared transform3d mapper.
  const spin = transformToUi(
    overlay.transform3d ?? {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    },
  ).spin;
  const setSpin = (next: number) => {
    const base = overlay.transform3d ?? {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    };
    onPatch({ transform3d: { ...base, rotation: { ...base.rotation, z: next * RAD } } });
  };

  // Position X/Y = the CONTENT CENTER of the box (not a corner). For a
  // frame-filling `code` box this keeps the slider direction intuitive (dragging
  // X right moves the content right); for a fitting box (image/video, default
  // mid-center anchor) it's identical to the old anchor-point behaviour. Editing
  // re-centres the box on the new point so the preview moves instantly.
  const posCenter = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const setPosition = (next: { x?: number; y?: number }) => {
    const c = {
      x: Math.round(next.x ?? posCenter.x),
      y: Math.round(next.y ?? posCenter.y),
    };
    const r = placeBoxAtAnchor(c, "mid-center", rect.width, rect.height);
    onPatch({
      position: c,
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: r.width, height: r.height },
    });
  };

  // Anchor pad = canvas-relative placement. Clicking a cell moves the box so its
  // CONTENT CENTER sits at the named region (`regionCenterPoint`): top→top,
  // left→left for ANY box size. A frame-filling box (e.g. `code`) lands its
  // content at ¼/½/¾ of the frame instead of the corner-anchor inversion; a
  // fitting box hugs the edge exactly like before. `anchor` is stored for the
  // pad highlight only.
  const placeAtCanvasAnchor = (a: CaptionAnchor) => {
    const c = regionCenterPoint(a, frame, { width: rect.width, height: rect.height });
    const r = placeBoxAtAnchor(c, "mid-center", rect.width, rect.height);
    onPatch({
      anchor: a,
      position: { x: Math.round(c.x), y: Math.round(c.y) },
      rect: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
    });
    onCommitEnd?.();
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Position (anchor-pinned X/Y) — not for tracked: its placement comes
          from the track (+ the follow-offset rows in the parent panel). */}
      {!tracked && (
      <div className="flex flex-col gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Position
        </h4>
        <div className="grid grid-cols-1 gap-2.5 @[300px]:gap-1.5">
          <div data-field="transformPosX">
            <NumberSlider
              label="X"
              unit="px"
              value={Math.round(posCenter.x)}
              min={0}
              max={frame.width}
              defaultValue={Math.round(frame.width / 2)}
              onChange={(v) => setPosition({ x: v })}
              onCommitEnd={onCommitEnd}
            />
          </div>
          <div data-field="transformPosY">
            <NumberSlider
              label="Y"
              unit="px"
              value={Math.round(posCenter.y)}
              min={0}
              max={frame.height}
              defaultValue={Math.round(frame.height / 2)}
              onChange={(v) => setPosition({ y: v })}
              onCommitEnd={onCommitEnd}
            />
          </div>
        </div>
      </div>
      )}

      {/* 3×3 anchor pad — snaps the rect to a canvas region (not for tracked;
          the rect x/y it writes is never read by resolveTrackedRect). */}
      {!tracked && (
      <div className="flex flex-col gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Anchor
        </h4>
        <AnchorPad anchor={anchor} onAnchorChange={placeAtCanvasAnchor} className="mx-auto" />
      </div>
      )}

      {/* Size — tracked: the uniform `scale` multiplier (the SAME field the
          preview corner handles write), shown as a percent of the tracked box.
          Other kinds: rect W/H with split memory. */}
      {tracked ? (
        <div data-field="transformSize">
          <NumberSlider
            label="Size"
            unit="%"
            value={trackedSizePctFromScale(tracked.scale)}
            min={trackedSizeFloorScale(tracked.scale) * 100}
            max={TRACKED_SCALE_MAX * 100}
            defaultValue={100}
            onChange={(v) =>
              onPatch({ scale: trackedScaleFromSizePct(v, tracked.scale) })
            }
            onCommitEnd={onCommitEnd}
          />
        </div>
      ) : (
      <div data-field="transformSize">
        <SizeField
          sizeMode="box"
          split={sizeSplit}
          onToggleSplit={onToggleSizeSplit}
          width={Math.round(rect.width)}
          height={Math.round(rect.height)}
          onCommitSize={(w, h) => {
            onPatch({
              rect: {
                ...rect,
                width: Math.max(1, Math.round(w)),
                height: Math.max(1, Math.round(h)),
              },
            });
            onCommitEnd?.();
          }}
          onCommitWidth={(w) => {
            onPatch({ rect: { ...rect, width: Math.max(1, Math.round(w)) } });
            onCommitEnd?.();
          }}
          onCommitHeight={(h) => {
            onPatch({ rect: { ...rect, height: Math.max(1, Math.round(h)) } });
            onCommitEnd?.();
          }}
        />
      </div>
      )}

      {/* In-plane Spin (transform3d.rotation.z) */}
      <div data-field="transformSpin">
        <NumberSlider
          label="Spin"
          unit="°"
          value={spin}
          min={-180}
          max={180}
          defaultValue={0}
          onChange={setSpin}
          onCommitEnd={onCommitEnd}
        />
      </div>
    </div>
  );
}
