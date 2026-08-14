"use client";

import type { ThreeOverlay, Transform3D } from "@/lib/engine/types";
import { IDENTITY_TRANSFORM3D, DEPTH_LIMIT_WORLD } from "@/lib/overlays/transform3d";
import { applyPosePreset, nearestPosePreset } from "@/lib/overlays/pose-presets";
import { NumberSlider } from "@/components/preview/number-slider";
import { RotationDialField } from "@/components/preview/rotation-dial-field";
import {
  transformToUi,
  uiToTransform,
} from "@/components/preview/transform-fields";
import { GroupField } from "@/components/preview/group-field";
import {
  CameraPresetGrid,
  type CameraPreset,
} from "@/components/preview/camera-preset-grid";
import type { InspectorGroup } from "@/lib/overlays/inspector-fields";

/**
 * ThreeInspector — the 3D-transform body of the Layers inspector for a `three`
 * overlay. Orientation is edited via the in-panel `RotationDialField` (three
 * circles — Angle yaw / Elevation pitch / Spin roll — plus editable degree
 * inputs); the illustrated preset grid snaps the orientation to a recognizable
 * POSE (billboard / ground / angled …). Depth (position.z) is a `NumberSlider`.
 * Scale was removed — size is the rect Size control on the Transform tab.
 * There is no camera-preset control anymore — the grid drives the rotation
 * controllers directly (the three.js camera stays at its default).
 *
 * The model stores rotation in RADIANS; the dial + mappers convert on the seam.
 * Every transform edit emits a full `{ transform3d }` partial so the PATCH route
 * receives a complete Transform3D.
 */
export function ThreeInspector({
  overlay,
  onPatch,
  onFlush,
  mode,
}: {
  overlay: ThreeOverlay;
  onPatch: (p: Partial<ThreeOverlay>) => void;
  /**
   * Persist the coalesced edit NOW. The dial + sliders paint per-change (onPatch
   * → shared store) and flush on release; discrete edits (pose, reset) both
   * paint and flush.
   */
  onFlush?: () => void;
  /** Active inspector group (three has the transform [2D rect] + 3D groups). */
  mode: InspectorGroup;
}) {
  const t: Transform3D = overlay.transform3d ?? IDENTITY_TRANSFORM3D;
  const ui = transformToUi(t);

  // Slider release: the per-change `onPatch` already painted; just flush.
  const flush = () => onFlush?.();
  // Discrete edit: paint via the shared store + flush the debounced PATCH.
  const patchAndFlush = (p: Partial<ThreeOverlay>) => {
    onPatch(p);
    onFlush?.();
  };

  // Map one semantic UI field back to a full Transform3D and patch it.
  const set = (next: Partial<typeof ui>) =>
    onPatch({ transform3d: uiToTransform({ ...ui, ...next }) });

  return (
    <div data-testid="three-inspector" className="flex flex-col gap-3">
      {/* Pose preset — the illustrated grid, now snapping orientation (rotation)
          to a recognizable pose rather than moving the camera. */}
      <GroupField fieldKey="transform3d.pose" kind="three" group={mode}>
        <Section label="Pose">
          <div data-testid="three-pose-grid">
            <CameraPresetGrid
              value={nearestPosePreset(t) as CameraPreset | null}
              onChange={(v) => patchAndFlush({ transform3d: applyPosePreset(t, v) })}
            />
          </div>
        </Section>
      </GroupField>

      {/* Reset 3D. */}
      <GroupField fieldKey="transform.reset" kind="three" group={mode}>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="three-reset"
            onClick={() => patchAndFlush({ transform3d: IDENTITY_TRANSFORM3D })}
            className="cursor-pointer rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            Reset 3D
          </button>
        </div>
      </GroupField>

      {/* Spatial orientation — the dial (Angle yaw + Elevation pitch + Spin roll)
          with three editable degree inputs. Replaces the per-axis sliders + the
          old floating on-canvas dial. */}
      <GroupField fieldKey="transform3d.rotation" kind="three" group={mode}>
        <Section label="Rotation">
          <RotationDialField
            transform3d={t}
            onChange={(next) => onPatch({ transform3d: next })}
            onFlush={flush}
          />
        </Section>
      </GroupField>

      {/* Depth (position.z) — the single remaining position control. */}
      <GroupField fieldKey="transform3d.position" kind="three" group={mode}>
        <NumberSlider
          label="Depth"
          value={Math.round(ui.posZ)}
          min={-DEPTH_LIMIT_WORLD}
          max={DEPTH_LIMIT_WORLD}
          step={1}
          defaultValue={0}
          onChange={(v) => set({ posZ: Math.round(v) })}
          onCommitEnd={flush}
        />
      </GroupField>

    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}
