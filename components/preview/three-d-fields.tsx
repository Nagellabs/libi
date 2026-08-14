"use client";

import type { Overlay } from "@/lib/engine/types";
import { resolveOverlayTransform } from "@/lib/engine/overlay-transform";
import {
  transformToUi,
  uiToTransform,
} from "@/components/preview/transform-fields";
import { DEPTH_LIMIT_PX } from "@/lib/overlays/transform3d";
import { NumberSlider } from "@/components/preview/number-slider";
import { RotationDialField } from "@/components/preview/rotation-dial-field";
import {
  CameraPresetGrid,
  type CameraPreset,
} from "@/components/preview/camera-preset-grid";
import { applyPosePreset, nearestPosePreset } from "@/lib/overlays/pose-presets";
import { flattenOverlay } from "@/lib/captions/flat-guard";
import { isOverlayIn3dMode } from "@/lib/overlays/three-d-mode";
import { GroupField } from "@/components/preview/group-field";
import { Switch } from "@/components/ui/switch";
import type { OverlayTransformPatch } from "@/hooks/editor/use-overlay-transform-commit";
import type { InspectorOverlayKind } from "@/lib/overlays/inspector-fields";
import { trackEvent } from "@/lib/analytics/client";

/**
 * ThreeDFields — the gated 3D panel for non-text / non-three overlay kinds
 * (image, video, code). It is the `3d` intent group's body:
 *
 *  - A "Make it 3D" `<Switch>` writing the `place3d` gate. ON promotes the layer
 *    into 3D mode (orbit gizmo on the canvas + the spatial controls below); OFF
 *    runs `flattenOverlay` (zeros pitch/yaw + depth, clears the gate) so a flat
 *    layer can never silently become 3D.
 *  - A Pose preset grid (snaps orientation to a recognizable pose) + the
 *    `RotationDialField` (Angle / Elevation / Spin circles with editable degree
 *    inputs) + Depth-Z. Scale was removed — size is the rect Size control on the
 *    Transform tab. All controls are disabled until the gate is on.
 *
 * Every field (incl. the toggle) is wrapped in `<GroupField group="3d">` so the
 * registry↔render coverage parity holds.
 */
export function ThreeDFields({
  overlay,
  onPatch,
  onCommitEnd,
}: {
  overlay: Overlay;
  onPatch: (patch: OverlayTransformPatch) => void;
  /** Fired when an edit ENDS (toggle flip / number blur / dial release) → flush. */
  onCommitEnd?: () => void;
}) {
  const kind = overlay.kind as InspectorOverlayKind;
  const on = isOverlayIn3dMode(overlay);
  const resolved = resolveOverlayTransform(overlay);
  const ui = transformToUi(resolved);

  const set = (next: Partial<typeof ui>) =>
    onPatch({ transform3d: uiToTransform({ ...ui, ...next }) });
  // Slider release / number blur / dial release → flush the debounced PATCH.
  const flush = () => onCommitEnd?.();

  return (
    <div className="flex flex-col gap-3">
      <GroupField fieldKey="place3d" kind={kind} group="3d">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Make it 3D
          </span>
          <Switch
            data-testid="place3d-toggle"
            checked={on}
            className="cursor-pointer"
            onCheckedChange={(v) => {
              if (v) {
                onPatch({ place3d: true });
                trackEvent("overlay_3d_used", { kind: overlay.kind });
              } else {
                // Send a full overlay-shaped flatten patch (place3d:false + zeroed
                // out-of-plane transform) — matching the caption disable3D shape.
                const flat = flattenOverlay(overlay);
                onPatch({ place3d: false, transform3d: flat.transform3d });
              }
              onCommitEnd?.();
            }}
          />
        </div>
      </GroupField>

      {/* Pose preset grid — snaps orientation to a recognizable pose. Disabled
          (dimmed, non-interactive) until "Make it 3D" is on. */}
      <GroupField fieldKey="transform3d.pose" kind={kind} group="3d">
        <div className="flex flex-col gap-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Pose
          </div>
          <div
            data-testid="three-d-pose-grid"
            className={on ? undefined : "pointer-events-none opacity-50"}
          >
            <CameraPresetGrid
              value={nearestPosePreset(resolved) as CameraPreset | null}
              onChange={(v) => {
                onPatch({ transform3d: applyPosePreset(resolved, v) });
                onCommitEnd?.();
              }}
            />
          </div>
        </div>
      </GroupField>

      {/* Rotation dial — Angle (yaw) / Elevation (pitch) / Spin (roll) circles +
          editable degree inputs. Disabled until "Make it 3D" is on so a flat
          layer can never be tilted by accident. */}
      <GroupField fieldKey="transform3d.rotation" kind={kind} group="3d">
        <div className="flex flex-col gap-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Rotation
          </div>
          <RotationDialField
            transform3d={resolved}
            locked={!on}
            onChange={(next) => onPatch({ transform3d: next })}
            onFlush={flush}
          />
        </div>
      </GroupField>

      {/* Depth. */}
      <GroupField fieldKey="transformPosZ" kind={kind} group="3d">
        <NumberSlider
          label="Depth"
          unit="px"
          value={Math.round(ui.posZ)}
          min={-DEPTH_LIMIT_PX}
          max={DEPTH_LIMIT_PX}
          step={25}
          defaultValue={0}
          onChange={(v) => set({ posZ: Math.round(v) })}
          onCommitEnd={flush}
          disabled={!on}
        />
      </GroupField>

      {!on && (
        <p className="text-[10px] leading-tight text-muted-foreground">
          Turn on <span className="text-foreground/80">Make it 3D</span> to tilt this layer in
          space.
        </p>
      )}
    </div>
  );
}
