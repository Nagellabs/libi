"use client";

import type {
  TextOverlay,
  CaptionBackground,
  CaptionStroke,
  CaptionShadow,
  CaptionReveal,
  TextThreeD,
  Transform3D,
} from "@/lib/engine/types";
import type { CaptionAnchor } from "@/lib/captions/types";
import { SAFE_FONTS } from "@/lib/overlays/caption-fonts";
import { CaptionStyleGrid } from "@/components/preview/caption-style-grid";
import { CAPTION_STYLES, captionStyleToFields } from "@/lib/captions/styles";
import type { CaptionStyle } from "@/lib/captions/types";
import {
  NumberSlider,
  INSPECTOR_LABEL_CLASS,
  INSPECTOR_ROW_GAP_CLASS,
} from "@/components/preview/number-slider";
import { Switch } from "@/components/ui/switch";
import { useOptimisticOverlay } from "@/lib/overlays/use-optimistic-overlay";
import { trackEvent } from "@/lib/analytics/client";
import { GroupField, GroupSection } from "@/components/preview/group-field";
import { InGroupAdvanced } from "@/components/preview/in-group-advanced";
import { transformToUi, uiToTransform } from "@/components/preview/transform-fields";
import {
  CameraPresetGrid,
  type CameraPreset,
} from "@/components/preview/camera-preset-grid";
import { IDENTITY_TRANSFORM3D, DEPTH_LIMIT_WORLD } from "@/lib/overlays/transform3d";
import { RotationDialField } from "@/components/preview/rotation-dial-field";
import { applyPosePreset, nearestPosePreset } from "@/lib/overlays/pose-presets";
import { resolveOverlayTransform } from "@/lib/engine/overlay-transform";
import { flattenOverlay } from "@/lib/captions/flat-guard";
import { isOverlayIn3dMode } from "@/lib/overlays/three-d-mode";
import { anchorToRect, anchorPointOf, placeBoxAtAnchor } from "@/lib/captions/anchor";
import { defaultAnchorForKind } from "@/lib/overlays/anchor-default";
import { AnchorPad } from "@/components/preview/anchor-pad";
import type { InspectorGroup } from "@/lib/overlays/inspector-fields";

/**
 * CaptionInspector — the FULL text-overlay inspector body. It owns ALL three
 * intent groups for a text overlay:
 *  - Transform: placement (3D transform panel) + anchor pad + a fontSize mirror
 *    + opacity/z-order/timing.
 *  - Style: STATIC look picker (style grid) + color + background + stroke +
 *    shadow. Reveal/animation is NOT here — it lives in Effects → Reveal.
 *  - Effects/Reveal split: "Reveal = how the words appear; Effects = how the
 *    box moves" (Effects live in the EffectsInspector sub-panel, not here).
 *  - Text: content + font family/weight/alignment/line-height + a Size mirror
 *    bound to the SAME fontSize.
 *
 * A controlled component: it reads everything from `overlay` and emits a
 * `Partial<TextOverlay>` patch via `onPatch` for every edit (the SAME
 * overlay-update PATCH the rest of the inspector uses — no new mutation).
 */
type CaptionPatch = Omit<
  Partial<TextOverlay>,
  "background" | "stroke" | "shadow" | "reveal" | "threeD"
> & {
  background?: CaptionBackground | null;
  stroke?: CaptionStroke | null;
  shadow?: CaptionShadow | null;
  reveal?: CaptionReveal | null;
  threeD?: TextThreeD | null;
};

export function CaptionInspector({
  overlay: overlayProp,
  onPatch,
  onFlush,
  mode,
  frame = { width: 1920, height: 1080 },
  videoDurationMs = 600000,
  captionStyles = CAPTION_STYLES,
}: {
  overlay: TextOverlay;
  onPatch: (p: CaptionPatch) => void;
  /**
   * Persist the coalesced edit NOW (flush the debounced PATCH owned by
   * PreviewSurface). `onPatch` already painted instantly via the shared edit
   * store; discrete edits (color, select, toggle, anchor/align/tilt buttons,
   * slider release) call this so the change persists promptly instead of
   * waiting for the trailing debounce.
   */
  onFlush?: () => void;
  /** Active inspector group (transform / style / text). */
  mode: InspectorGroup;
  /** Piece the overlay belongs to (kept for API parity with the other
   *  inspectors; the Style tab's look picker commits via `onPatch`). */
  pieceId: string;
  /** Composition pixel dimensions — drives the anchor pad's canvas-relative
   *  placement and the Position slider ranges. */
  frame?: { width: number; height: number };
  /** Total video (scene) duration in ms — caps the Start/End timing sliders so
   *  they never run past the footage. */
  videoDurationMs?: number;
  /** Bundled + user caption styles for the Style-tab picker. Defaults to the
   *  bundled const; the panel passes the merged list from `useCaptionStyles`. */
  captionStyles?: CaptionStyle[];
}) {
  // Route every control through the optimistic layer so enable toggles flip
  // instantly (and the always-mounted detail fields enable) before any refetch.
  const { view: overlay, patch } = useOptimisticOverlay(
    overlayProp,
    onPatch as (p: Record<string, unknown>) => void,
  );
  // A DISCRETE caption edit (color pick, select, switch, anchor/align/tilt
  // button) — paint via the optimistic patch (shared store) AND flush the
  // debounced PATCH. Continuous sliders stay on `patch` per-change and flush on
  // release via NumberSlider's `onCommitEnd`.
  const patchAndFlush = (p: CaptionPatch) => {
    patch(p as Record<string, unknown>);
    onFlush?.();
  };
  // Slider release: the per-change `patch` already painted/coalesced; just flush.
  const flush = () => onFlush?.();
  const bgOn = !!overlay.background;
  const strokeOn = !!overlay.stroke;
  const shadowOn = !!overlay.shadow;
  const threeDOn = !!overlay.threeD;
  const fontSize = Math.round(overlay.fontSize ?? 48);

  // Transform UI (shared mapper with TransformFields).
  const tUi = transformToUi(resolveOverlayTransform(overlay));
  const setTransform = (next: Partial<typeof tUi>) =>
    patch({ transform3d: uiToTransform({ ...tUi, ...next }) as Transform3D } as CaptionPatch);

  // Turning 3D OFF: clear the place3d gate, drop the extrusion, AND zero the
  // out-of-plane rotation (pitch/yaw) + depth that would leave the glyphs edge-on.
  // `flattenOverlay` builds the flat candidate; we patch the diff — `place3d:false`
  // + `threeD: null` (clears the field) + the zeroed `transform3d` when it actually
  // changed. In-plane (z-roll) spin, position X/Y, and scale are preserved.
  const disable3D = () => {
    const flat = flattenOverlay(overlay);
    const diff: CaptionPatch = { place3d: false, threeD: null };
    if (flat.transform3d && overlay.transform3d !== flat.transform3d) {
      diff.transform3d = flat.transform3d;
    }
    patchAndFlush(diff);
  };

  // Is the caption in 3D mode (place3d gate, legacy threeD, or a spatial transform)?
  const in3d = isOverlayIn3dMode(overlay);

  const wrapOn = overlay.maxWidthPct != null;
  const anchor = overlay.anchor ?? defaultAnchorForKind("text");

  // Position X/Y = the caption's actual placement point (the anchor pin a canvas
  // body-drag moves), NOT the transform3d offset. Reading `overlay.position`
  // (falling back to the anchor point of the current rect) makes the X/Y sliders
  // track a drag once it commits — like the other sliders track their fields.
  // Editing a slider re-pins the box: we patch `position` AND recompute `rect`
  // via placeBoxAtAnchor so the preview moves instantly (the server recomputes
  // the same rect from anchor+position on save).
  const posPin = overlay.position ?? anchorPointOf(overlay.rect, anchor);
  const setCaptionPosition = (next: { x?: number; y?: number }) => {
    const pos = {
      x: Math.round(next.x ?? posPin.x),
      y: Math.round(next.y ?? posPin.y),
    };
    const r = placeBoxAtAnchor(pos, anchor, overlay.rect.width, overlay.rect.height);
    patch({
      position: pos,
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: r.width, height: r.height },
    } as CaptionPatch);
  };

  // Anchor pad = canvas-relative alignment. Clicking a cell snaps the caption to
  // that region of the PREVIEW CANVAS (top-left → top-left of frame, mid-center
  // → frame center, bottom-center → bottom-center, …). We set `anchor` (the pin
  // corner, so later nudges feel right), `position` (the canvas point that pin
  // sits at, with a safe margin), AND the derived top-left `rect` so the preview
  // repaints to the new spot instantly instead of waiting for the server to
  // recompute the rect on save. `anchorToRect` already places the box's corner
  // at the matching frame corner; `anchorPointOf` reads back the pin point.
  const placeAtCanvasAnchor = (a: CaptionAnchor) => {
    const size = { width: overlay.rect.width, height: overlay.rect.height };
    const r = anchorToRect(a, frame, size);
    const pin = anchorPointOf(r, a);
    patchAndFlush({
      anchor: a,
      position: { x: Math.round(pin.x), y: Math.round(pin.y) },
      rect: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
    } as CaptionPatch);
  };

  return (
    <div data-testid="caption-inspector" className="flex flex-col gap-4">
      {/* ── TRANSFORM group ───────────────────────────────────────────── */}
      {mode === "transform" && (
        <>
          {/* Position — 3D transform offset (Position X/Y), in composition px;
              0 = no offset (the anchor-pad placement is the base location). */}
          <Section label="Position">
            <div className="grid grid-cols-1 gap-2.5 @[300px]:gap-1.5">
              <GroupField fieldKey="transformPosX" kind="text" group={mode}>
                <NumberSlider label="X" value={Math.round(posPin.x)} min={0} max={frame.width} onChange={(v) => setCaptionPosition({ x: v })} onCommitEnd={flush} />
              </GroupField>
              <GroupField fieldKey="transformPosY" kind="text" group={mode}>
                <NumberSlider label="Y" value={Math.round(posPin.y)} min={0} max={frame.height} onChange={(v) => setCaptionPosition({ y: v })} onCommitEnd={flush} />
              </GroupField>
            </div>
          </Section>

          {/* 3×3 anchor pad — sets the `anchor` placement pin. */}
          <Section label="Anchor">
            <AnchorPad
              anchor={anchor}
              onAnchorChange={placeAtCanvasAnchor}
              className="mx-auto"
            />
          </Section>

          {/* Size mirror — drives fontSize (the SAME field as the Text tab's
              Size). Carries data-field="fontSize" as a deliberate mirror. Single
              row (no section header) — the slider label IS the title. */}
          <div data-field="fontSize" data-mirror="fontSize">
            <NumberSlider
              label="Size"
              unit="px"
              value={fontSize}
              min={4}
              max={400}
              defaultValue={48}
              onChange={(v) => patch({ fontSize: Math.max(4, Math.round(v)) })}
              onCommitEnd={flush}
            />
          </div>

          {/* In-plane rotate (Spin). Writes `transform3d.rotation.z` — the SINGLE
              rotation authority (there is no legacy `rotation` storage field).
              Rotate (in-plane spin) is text's single always-on 2D control on the
              Transform tab — the registry's `rotation` inspector key (image/video/
              code use `transformSpin` instead; text deliberately does not register
              `transformSpin` to avoid a duplicate spin control). The out-of-plane
              3D angles (Angle / Elevation / Depth-Z) live in the 3D tab behind
              the "Make it 3D" gate. Caption SIZE is the single `fontSize` control
              (above + in the Text tab); there is deliberately NO separate
              uniform-scale slider for text (font size IS the size). */}
          <GroupField fieldKey="rotation" kind="text" group={mode}>
            <NumberSlider
              label="Rotate"
              unit="°"
              value={tUi.spin}
              min={-180}
              max={180}
              defaultValue={0}
              onChange={(v) => setTransform({ spin: v })}
              onCommitEnd={flush}
            />
          </GroupField>

          {/* Opacity (common) + Z-order/Timing behind in-group Advanced. */}
          <InGroupAdvanced
            common={
              <GroupField fieldKey="opacity" kind="text" group={mode}>
                <NumberSlider
                  label="Opacity"
                  unit="%"
                  value={Math.round((overlay.opacity ?? 1) * 100)}
                  min={0}
                  max={100}
                  defaultValue={100}
                  onChange={(v) => patch({ opacity: Math.max(0, Math.min(1, v / 100)) })}
                  onCommitEnd={flush}
                />
              </GroupField>
            }
            advanced={
              <>
                <GroupField fieldKey="zOrder" kind="text" group={mode}>
                  <NumberSlider label="Layer order" value={Math.round(overlay.z ?? 0)} min={0} max={100} defaultValue={0} onChange={(v) => patch({ z: Math.round(v) } as CaptionPatch)} onCommitEnd={flush} />
                </GroupField>
                <GroupField fieldKey="startTime" kind="text" group={mode}>
                  <NumberSlider label="Start" unit="ms" value={Math.round(overlay.startTime * 1000)} min={0} max={videoDurationMs} step={10} defaultValue={0} onChange={(v) => patch({ startTime: Math.max(0, Math.min(videoDurationMs / 1000, v / 1000)) } as CaptionPatch)} onCommitEnd={flush} />
                </GroupField>
                <GroupField fieldKey="endTime" kind="text" group={mode}>
                  <NumberSlider
                    label="End"
                    unit="ms"
                    value={Math.round((overlay.startTime + overlay.duration) * 1000)}
                    min={0}
                    max={videoDurationMs}
                    step={10}
                    onChange={(v) => {
                      const cap = Math.min(videoDurationMs, v);
                      const end = Math.max(overlay.startTime * 1000 + 1, cap) / 1000;
                      patch({ duration: Math.max(1 / 30, end - overlay.startTime) } as CaptionPatch);
                    }}
                    onCommitEnd={flush}
                  />
                </GroupField>
              </>
            }
          />
        </>
      )}

      {/* ── STYLE group ──────────────────────────────────────────────── */}
      {mode === "style" && (
        <>
          {/* Static look picker (single source — no animation, no duplicate
              preset chip row; full-overlay presets live next to "+ Add"). The
              bottom border + padding separate the (large, scrollable) catalog
              from the per-property controls below. */}
          <GroupField fieldKey="style" kind="text" group={mode}>
            <div className="border-b border-border/60 pb-4">
              <Section label="Style">
                <CaptionStyleGrid
                  overlay={overlay}
                  styles={captionStyles}
                  onApplyStyle={(styleId) => {
                    const s = captionStyles.find((x) => x.id === styleId);
                    if (s) patchAndFlush(captionStyleToFields(s) as CaptionPatch);
                  }}
                />
              </Section>
            </div>
          </GroupField>

          {/* Color */}
          <GroupField fieldKey="color" kind="text" group={mode}>
            <Row label="Color">
              <ColorField testId="caption-color" value={overlay.color} onChange={(v) => patchAndFlush({ color: v })} />
            </Row>
          </GroupField>

          {/* Background — toggle + detail fields (always mounted, dimmed when off). */}
          <GroupSection
            title=""
            fieldKeys={["background", "background.color", "background.padding", "background.radius"]}
            kind="text"
            group={mode}
          >
            <div className="flex flex-col gap-2">
              <GroupField fieldKey="background" kind="text" group={mode}>
                <div className="flex items-center justify-between">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Background
                  </div>
                  <Switch
                    data-testid="background-toggle"
                    checked={bgOn}
                    onCheckedChange={(v) =>
                      v
                        ? patchAndFlush({ background: { color: "rgba(0,0,0,0.6)", padding: 12, radius: 8 } })
                        : patchAndFlush({ background: null })
                    }
                    className="cursor-pointer"
                  />
                </div>
              </GroupField>
              <GroupField fieldKey="background.color" kind="text" group={mode}>
                <Row label="Color">
                  <ColorField
                    testId="background-color"
                    disabled={!bgOn}
                    value={overlay.background?.color ?? "rgba(0,0,0,0.6)"}
                    onChange={(v) => patchAndFlush({ background: { ...(overlay.background ?? {}), color: v } })}
                  />
                </Row>
              </GroupField>
              <GroupField fieldKey="background.padding" kind="text" group={mode}>
                <NumberSlider
                  label="Padding"
                  unit="px"
                  value={Math.round(overlay.background?.padding ?? 12)}
                  min={0}
                  max={120}
                  defaultValue={12}
                  onChange={(v) =>
                    patch({ background: { ...(overlay.background ?? { color: "rgba(0,0,0,0.6)" }), padding: Math.max(0, v) } })
                  }
                  onCommitEnd={flush}
                />
              </GroupField>
              <GroupField fieldKey="background.radius" kind="text" group={mode}>
                <NumberSlider
                  label="Radius"
                  unit="px"
                  value={Math.round(overlay.background?.radius ?? 8)}
                  min={0}
                  max={120}
                  defaultValue={8}
                  onChange={(v) =>
                    patch({ background: { ...(overlay.background ?? { color: "rgba(0,0,0,0.6)" }), radius: Math.max(0, v) } })
                  }
                  onCommitEnd={flush}
                />
              </GroupField>
            </div>
          </GroupSection>

          {/* Stroke */}
          <GroupField fieldKey="stroke" kind="text" group={mode}>
            <PropertyToggle
              label="Stroke"
              testId="stroke-toggle"
              enabled={strokeOn}
              onEnable={() => patchAndFlush({ stroke: { color: "#000000", width: 6 } })}
              onDisable={() => patchAndFlush({ stroke: null })}
            >
              <div className="flex flex-col gap-2">
                <Row label="Color">
                  <ColorField
                    testId="stroke-color"
                    disabled={!strokeOn}
                    value={overlay.stroke?.color ?? "#000000"}
                    onChange={(v) => patchAndFlush({ stroke: { ...(overlay.stroke ?? { width: 6 }), color: v } })}
                  />
                </Row>
                <NumberSlider
                  label="Width"
                  unit="px"
                  value={Math.round(overlay.stroke?.width ?? 6)}
                  min={0}
                  max={40}
                  defaultValue={6}
                  onChange={(v) => patch({ stroke: { ...(overlay.stroke ?? { color: "#000000" }), width: Math.max(0, v) } })}
                  onCommitEnd={flush}
                />
              </div>
            </PropertyToggle>
          </GroupField>

          {/* Shadow */}
          <GroupField fieldKey="shadow" kind="text" group={mode}>
            <PropertyToggle
              label="Shadow"
              testId="shadow-toggle"
              enabled={shadowOn}
              onEnable={() => patchAndFlush({ shadow: { color: "rgba(0,0,0,0.7)", blur: 8 } })}
              onDisable={() => patchAndFlush({ shadow: null })}
            >
              <div className="flex flex-col gap-2">
                <Row label="Color">
                  <ColorField
                    testId="shadow-color"
                    disabled={!shadowOn}
                    value={overlay.shadow?.color ?? "rgba(0,0,0,0.7)"}
                    onChange={(v) => patchAndFlush({ shadow: { ...(overlay.shadow ?? { blur: 8 }), color: v } })}
                  />
                </Row>
                <NumberSlider
                  label="Blur"
                  unit="px"
                  value={Math.round(overlay.shadow?.blur ?? 8)}
                  min={0}
                  max={60}
                  defaultValue={8}
                  onChange={(v) => patch({ shadow: { ...(overlay.shadow ?? { color: "rgba(0,0,0,0.7)" }), blur: Math.max(0, v) } })}
                  onCommitEnd={flush}
                />
              </div>
            </PropertyToggle>
          </GroupField>

          {/* Text reveal (typewriter / karaoke / paint-on …) now lives in the
              Effects panel's "Reveal" family tab — it's a single-select over
              `overlay.reveal`, alongside the box-motion effects. */}
          <p className="text-[10px] leading-tight text-muted-foreground">
            Word reveals (typewriter, karaoke, paint-on…) live in the{" "}
            <span className="text-foreground/80">Effects → Reveal</span> tab.
          </p>
        </>
      )}

      {/* ── 3D group ─────────────────────────────────────────────────── */}
      {mode === "3d" && (
        <>
          {/* "Make it 3D" gate — the place3d toggle. ON promotes the caption into
              3D mode (orbit gizmo + on-surface Angle/Elevation/Depth-Z). It NO
              LONGER auto-creates extrusion — that's a further opt-in (Extrude
              below, Depth default 0). OFF runs disable3D() → clears place3d +
              threeD + zeros pitch/yaw/depth (flattenOverlay). */}
          <GroupField fieldKey="place3d" kind="text" group={mode}>
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Make it 3D
              </div>
              <Switch
                data-testid="place3d-toggle"
                checked={in3d}
                onCheckedChange={(v) => {
                  if (v) {
                    patchAndFlush({ place3d: true });
                    // Keep the legacy text-specific event (unbroken history) AND
                    // emit the unified per-kind event so all flat kinds funnel
                    // through one place3d-ON event.
                    trackEvent("text_3d_used", { source: "inspector" });
                    trackEvent("overlay_3d_used", { kind: "text" });
                  } else {
                    disable3D();
                  }
                }}
                className="cursor-pointer"
              />
            </div>
          </GroupField>

          {/* Orientation + extrusion body — gated by the place3d gate (3D mode).
              When flat, none of these render (so a flat caption can't be tilted). */}
          {in3d && (
            <>
              {/* Spatial orientation — same vocabulary as every other 3D panel:
                  the Pose grid snaps orientation to a recognizable pose; the dial
                  (Angle yaw / Elevation pitch / Spin roll circles + editable degree
                  inputs) is the fine control. Depth-Z stays as a slider.
                  Scale was removed — size is the rect Size control on the
                  Transform tab. data-testid kept for existing QA selectors. */}
              <div data-testid="manual-angles" className="flex flex-col gap-1.5">
                <GroupField fieldKey="transform3d.pose" kind="text" group={mode}>
                  <Section label="Pose">
                    <div data-testid="text-pose-grid">
                      <CameraPresetGrid
                        value={nearestPosePreset(resolveOverlayTransform(overlay)) as CameraPreset | null}
                        onChange={(v) =>
                          patchAndFlush({
                            transform3d: applyPosePreset(resolveOverlayTransform(overlay), v) as Transform3D,
                          } as CaptionPatch)
                        }
                      />
                    </div>
                  </Section>
                </GroupField>
                <GroupField fieldKey="transform3d.rotation" kind="text" group={mode}>
                  <Section label="Rotation">
                    <RotationDialField
                      transform3d={resolveOverlayTransform(overlay)}
                      onChange={(next) => patch({ transform3d: next as Transform3D } as CaptionPatch)}
                      onFlush={flush}
                    />
                  </Section>
                </GroupField>
                <GroupField fieldKey="transformPosZ" kind="text" group={mode}>
                  <NumberSlider label="Depth" value={Math.round(tUi.posZ)} min={-DEPTH_LIMIT_WORLD} max={DEPTH_LIMIT_WORLD} step={1} defaultValue={0} onChange={(v) => setTransform({ posZ: Math.round(v) })} onCommitEnd={flush} />
                </GroupField>
              </div>

              {/* Section heading — the extrusion group (gives the glyphs depth /
                  bevel / lit faces; distinct from the box-tilt above). */}
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Style the letters (extrude)
              </div>
              {/* (The old extrusion "Camera" preset grid was removed — orientation
                  is driven solely by the unified Pose grid + dial above, which the
                  extruded-text builder honors via transform3d.rotation. The
                  three.js camera stays at its default for extruded text.) */}

              {/* Extrude — the volumetric extrusion opt-in (Depth default 0).
                  Toggling ON lazily creates threeD; the Thickness slider raises
                  it. The extrusion controls below stay MOUNTED but go disabled
                  (greyed) when Extrude is off — no Advanced disclosure, flat
                  rows. */}
              <GroupField fieldKey="text3dEnabled" kind="text" group={mode}>
                <div className="flex items-center justify-between">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Extrude
                  </div>
                  <Switch
                    data-testid="text3d-toggle"
                    checked={threeDOn}
                    onCheckedChange={(v) => {
                      if (v) {
                        // Depth default 0 — extrusion is opt-in; raise the
                        // Thickness slider above 0 to actually thicken the glyphs.
                        patchAndFlush({ threeD: overlay.threeD ?? { depth: 0 } });
                      } else {
                        patchAndFlush({ threeD: null });
                      }
                    }}
                    className="cursor-pointer"
                  />
                </div>
              </GroupField>

              {/* Extrusion fine controls — ALWAYS mounted (disabled when Extrude
                  is off), flat (no Advanced disclosure). Depth → "Thickness" to
                  avoid colliding with the spatial "Depth" (transformPosZ) row. */}
              <div className="flex flex-col gap-2">
                <GroupField fieldKey="text3dDepth" kind="text" group={mode}>
                  <NumberSlider
                    label="Thickness"
                    unit="px"
                    disabled={!threeDOn}
                    value={Math.round(overlay.threeD?.depth ?? 0)}
                    min={0}
                    max={120}
                    defaultValue={0}
                    onChange={(v) => patch({ threeD: { ...(overlay.threeD ?? { depth: 0 }), depth: Math.max(0, v) } })}
                    onCommitEnd={flush}
                  />
                </GroupField>
                <GroupField fieldKey="text3dBevel" kind="text" group={mode}>
                  <NumberSlider
                    label="Bevel"
                    unit="px"
                    disabled={!threeDOn}
                    value={Math.round(overlay.threeD?.bevel ?? 0)}
                    min={0}
                    max={40}
                    defaultValue={0}
                    onChange={(v) => patch({ threeD: { ...(overlay.threeD ?? { depth: 0 }), bevel: Math.max(0, v) } })}
                    onCommitEnd={flush}
                  />
                </GroupField>
                <div className="grid grid-cols-2 gap-2">
                  <GroupField fieldKey="text3dFrontColor" kind="text" group={mode}>
                    <Row label="Front">
                      <ColorField
                        testId="text3d-front-color"
                        disabled={!threeDOn}
                        value={overlay.threeD?.frontColor ?? "#ffffff"}
                        onChange={(v) => patchAndFlush({ threeD: { ...(overlay.threeD ?? { depth: 0 }), frontColor: v } })}
                      />
                    </Row>
                  </GroupField>
                  <GroupField fieldKey="text3dSideColor" kind="text" group={mode}>
                    <Row label="Side">
                      <ColorField
                        testId="text3d-side-color"
                        disabled={!threeDOn}
                        value={overlay.threeD?.sideColor ?? "#888888"}
                        onChange={(v) => patchAndFlush({ threeD: { ...(overlay.threeD ?? { depth: 0 }), sideColor: v } })}
                      />
                    </Row>
                  </GroupField>
                </div>
                <GroupField fieldKey="text3dLighting" kind="text" group={mode}>
                  <Row label="Lighting">
                    <div className={threeDOn ? undefined : "pointer-events-none opacity-50"}>
                      <NativeSelect
                        testId="text3d-lighting"
                        value={overlay.threeD?.lighting ?? "studio"}
                        onChange={(v) => patchAndFlush({ threeD: { ...(overlay.threeD ?? { depth: 0 }), lighting: v as TextThreeD["lighting"] } })}
                        options={LIGHTING_OPTIONS}
                      />
                    </div>
                  </Row>
                </GroupField>
              </div>

              {/* Reset 3D — same identity patch as the three inspector. */}
              <GroupField fieldKey="transform.reset" kind="text" group={mode}>
                <button
                  type="button"
                  data-testid="text-reset-3d"
                  onClick={() => patchAndFlush({ transform3d: IDENTITY_TRANSFORM3D as Transform3D })}
                  className="cursor-pointer self-start rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  Reset 3D
                </button>
              </GroupField>

              {/* Gizmo callout. */}
              <p className="text-[10px] leading-tight text-muted-foreground">
                Rotate with the circles above; move &amp; resize on the canvas.
              </p>
            </>
          )}
        </>
      )}

      {/* ── TEXT group ───────────────────────────────────────────────── */}
      {mode === "text" && (
        <>
          {/* Content */}
          <GroupField fieldKey="content" kind="text" group={mode}>
            <Section label="Content">
              <textarea
                data-testid="caption-content"
                defaultValue={overlay.content}
                onChange={(e) => patch({ content: e.target.value })}
                onBlur={flush}
                rows={2}
                className="w-full resize-y rounded border border-border bg-background px-1.5 py-1 text-[11px] text-foreground"
              />
            </Section>
          </GroupField>

          {/* Typography — roomier gap so Family / Weight / Alignment breathe. */}
          <Section label="Typography" gap="gap-3">
            <GroupField fieldKey="fontFamily" kind="text" group={mode}>
              <Row label="Family">
                <NativeSelect
                  testId="caption-font-family"
                  value={overlay.fontFamily ?? ""}
                  onChange={(v) => patchAndFlush({ fontFamily: v })}
                  options={[
                    { value: "", label: "Default" },
                    ...SAFE_FONTS.map((f) => ({ value: f, label: f })),
                  ]}
                />
              </Row>
            </GroupField>
            <GroupField fieldKey="fontWeight" kind="text" group={mode}>
              <Row label="Weight">
                <NativeSelect
                  testId="caption-font-weight"
                  value={String(overlay.fontWeight ?? 400)}
                  onChange={(v) => patchAndFlush({ fontWeight: Number(v) })}
                  options={[
                    { value: "400", label: "Normal" },
                    { value: "500", label: "Medium" },
                    { value: "600", label: "Semibold" },
                    { value: "700", label: "Bold" },
                    { value: "900", label: "Black" },
                  ]}
                />
              </Row>
            </GroupField>
            <GroupField fieldKey="align" kind="text" group={mode}>
              <Row label="Alignment">
                <div className="flex gap-1">
                  {(["left", "center", "right"] as const).map((a) => (
                    <button
                      key={a}
                      type="button"
                      data-testid={`caption-align-${a}`}
                      onClick={() => patchAndFlush({ align: a })}
                      className={`flex-1 cursor-pointer rounded border px-2 py-1 text-[11px] capitalize ${
                        overlay.align === a
                          ? "border-primary bg-primary/15 text-foreground"
                          : "border-border text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {a}
                    </button>
                  ))}
                </div>
              </Row>
            </GroupField>
            {/* Caption Size lives on the Transform tab (font size IS the
                caption's size) — no duplicate control here. */}
            {/* Line height — vertical spacing between WRAPPED lines of the
                caption (only visible on 2+ line captions). Single labelled row,
                like the other sliders. */}
            <NumberSlider
              label="Line gap"
              unit="×"
              value={overlay.lineHeight ?? 1.2}
              min={0.8}
              max={3}
              step={0.05}
              defaultValue={1.2}
              onChange={(v) => patch({ lineHeight: Math.max(0.8, v) } as CaptionPatch)}
              onCommitEnd={flush}
            />
            {/* Wrap width — toggle + maxWidthPct slider. The slider stays mounted
                and goes DISABLED (dimmed) when wrap is off, like the other
                toggle-gated rows. Default when enabled: 80% (wraps before the
                caption reaches the frame edge). */}
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">Wrap width</span>
              <Switch
                data-testid="caption-wrap-toggle"
                checked={wrapOn}
                onCheckedChange={(v) =>
                  patchAndFlush({ maxWidthPct: v ? (overlay.maxWidthPct ?? 0.8) : undefined } as CaptionPatch)
                }
                className="cursor-pointer"
              />
            </div>
            <NumberSlider
              label="Max width"
              unit="%"
              disabled={!wrapOn}
              value={Math.round((overlay.maxWidthPct ?? 0.8) * 100)}
              min={5}
              max={100}
              defaultValue={80}
              onChange={(v) => patch({ maxWidthPct: Math.min(1, Math.max(0.05, v / 100)) } as CaptionPatch)}
              onCommitEnd={flush}
            />
          </Section>
        </>
      )}
    </div>
  );
}

const LIGHTING_OPTIONS: { value: string; label: string }[] = [
  { value: "studio", label: "Studio" },
  { value: "soft", label: "Soft" },
  { value: "dramatic", label: "Dramatic" },
  { value: "flat", label: "Flat" },
];

function Section({
  label,
  children,
  gap = "gap-2",
}: {
  label: string;
  children: React.ReactNode;
  /** Vertical gap between the section's rows (Tailwind gap class). */
  gap?: string;
}) {
  return (
    <div className={`flex flex-col ${gap}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

/**
 * A labelled inspector row. Horizontal: a fixed-width label cell (shared with
 * NumberSlider via INSPECTOR_LABEL_CLASS) + a flex-1 control area, so labels
 * across selects / colors / chip rows line up to the same left edge as the
 * slider labels.
 */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className={`flex items-center ${INSPECTOR_ROW_GAP_CLASS} text-[11px]`}>
      <span className={INSPECTOR_LABEL_CLASS}>{label}</span>
      <span className="flex min-w-0 flex-1 items-center">{children}</span>
    </label>
  );
}

/**
 * A property section whose detail fields are ALWAYS mounted (passed as
 * `children`, disabled+dimmed by the caller when off) — so enabling never
 * shoves the layout down via a mount jump. The enable Switch sits in the row
 * header; toggling routes through the optimistic patch so it flips instantly.
 */
function PropertyToggle({
  label,
  testId,
  enabled,
  onEnable,
  onDisable,
  children,
}: {
  label: string;
  testId: string;
  enabled: boolean;
  onEnable: () => void;
  onDisable: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <Switch
          data-testid={testId}
          checked={enabled}
          onCheckedChange={(v) => (v ? onEnable() : onDisable())}
          className="cursor-pointer"
        />
      </div>
      {children}
    </div>
  );
}

function NativeSelect({
  testId,
  value,
  onChange,
  options,
}: {
  testId: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      data-testid={testId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full min-w-0 cursor-pointer rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function ColorField({
  testId,
  value,
  onChange,
  disabled,
}: {
  testId: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <span className={`flex min-w-0 items-center gap-1 ${disabled ? "opacity-50" : ""}`}>
      <input
        type="color"
        data-testid={testId}
        disabled={disabled}
        value={toHexColor(value)}
        onChange={(e) => onChange(e.target.value)}
        className="h-5 w-7 shrink-0 cursor-pointer rounded border border-border bg-background disabled:cursor-not-allowed"
      />
      <input
        type="text"
        data-testid={`${testId}-text`}
        disabled={disabled}
        defaultValue={value}
        onBlur={(e) => {
          const v = e.currentTarget.value.trim();
          if (v) onChange(v);
        }}
        className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 font-mono text-[10px] text-foreground disabled:cursor-not-allowed"
      />
    </span>
  );
}

/** `<input type="color">` only accepts `#rrggbb`. Map rgba()/named values to a
 *  best-effort hex so the swatch shows something; the text input keeps the raw
 *  value editable. */
function toHexColor(value: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    const [r, g, b] = value.slice(1).split("");
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return "#000000";
}
