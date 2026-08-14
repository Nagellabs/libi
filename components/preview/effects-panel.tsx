// components/preview/effects-panel.tsx
"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { X, Search } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { Composition, TextOverlay } from "@/lib/engine/types";
import type { EffectPhase, LayerKind, LayerEffects } from "@/lib/effects/types";
import { listEffects } from "@/lib/effects/registry";
import { useSelectedOverlay } from "@/hooks/preview/use-selected-overlay";
import { classifySelection } from "@/lib/preview/selection-classify";
import type { SelectionStore } from "@/lib/preview/selection-store";
import { useEditorState } from "@/lib/editor-state-context";
import { useApplyLayerEffect, useClearLayerEffect } from "@/lib/queries/effects";
import { useCustomEffects } from "@/lib/queries/effects-catalog";
import { EffectThumbnail } from "@/components/preview/effect-thumbnail";
import { RevealThumbnail } from "@/components/preview/reveal-thumbnail";
import { pieceKeys } from "@/lib/queries/pieces";
import {
  REVEAL_MODES,
  isRevealModeEnabled,
  revealDisabledReason,
  type RevealModeDef,
} from "@/lib/captions/reveal-modes";
import { effectPreviewWindowSec } from "@/lib/preview/effect-preview-window";
import type { EffectPreviewStore } from "@/lib/preview/effect-preview-store";
import { trackEvent } from "@/lib/analytics/client";
import { NumberSlider } from "@/components/preview/number-slider";
import {
  useEffectHighlightValue,
  type EffectHighlightStore,
} from "@/lib/preview/effect-highlight-store";
import { useSelectedKeyframe } from "@/hooks/preview/use-selected-keyframe";
import {
  keyframeSelectionKey,
  type KeyframeSelectionStore,
} from "@/lib/preview/keyframe-selection-store";
import { KeyframesTab } from "@/components/preview/keyframes-tab";

interface EffectsPanelProps {
  pieceId: string;
  composition: Composition | null;
  selectionStore: SelectionStore;
  effectHighlightStore: EffectHighlightStore;
  effectPreviewStore: EffectPreviewStore;
  /** The selected keyframe store — drives the Keyframes family tab (curve editor). */
  keyframeSelectionStore: KeyframeSelectionStore;
  readOnly: boolean;
  onClose: () => void;
  /** Add a keyframe on an overlay at the live playhead (Keyframes tab button). */
  onAddKeyframeAtPlayhead: (overlayId: string) => void;
  /** External "open on this family" request (e.g. inspector Reveal row). Keyed
   *  on the nonce so the same family can be requested twice. */
  familyRequest?: { family: EffectsFamily; nonce: number } | null;
}

export type EffectsFamily = "animation" | "reveal" | "custom" | "keyframes";
type Family = EffectsFamily;

/** Static family tabs. `reveal` is text-only; `custom`/`keyframes` enablement
 *  is computed (custom = has a custom effect for kind/phase; keyframes = the
 *  selected layer has keyframes OR a keyframe is selected). */
const FAMILY_TABS = [
  { id: "animation", label: "Animations" },
  { id: "reveal", label: "Reveal" },
  { id: "keyframes", label: "Keyframes" },
  { id: "custom", label: "Custom" },
] as const;

interface SelectedLayer {
  layerId: string;
  kind: LayerKind;
  effects?: LayerEffects;
  /** Present only for text overlays — drives the Reveal family. */
  reveal?: TextOverlay["reveal"];
  isThreeD?: boolean;
}

/** Map a classified selection to a LayerKind the registry filters on. */
function selectedLayer(selectionId: string | null, comp: Composition | null): SelectedLayer | null {
  const cls = classifySelection(selectionId, comp);
  if (!cls) return null;
  if (cls.kind === "overlay") {
    const ov = cls.overlay;
    const base: SelectedLayer = { layerId: ov.id, kind: ov.kind as LayerKind, effects: ov.effects };
    if (ov.kind === "text") {
      base.reveal = (ov as TextOverlay).reveal;
      base.isThreeD = !!(ov as TextOverlay).threeD;
    }
    return base;
  }
  if (cls.kind === "scene") {
    return { layerId: cls.scene.id, kind: "scene", effects: cls.scene.effects };
  }
  return { layerId: cls.clip.id, kind: "audio", effects: cls.clip.effects };
}

function phasesForKind(kind: LayerKind): EffectPhase[] {
  return kind === "audio" ? ["in", "out"] : ["in", "out", "loop"];
}

export function EffectsPanel({
  pieceId,
  composition,
  selectionStore,
  effectHighlightStore,
  effectPreviewStore,
  keyframeSelectionStore,
  readOnly,
  onClose,
  onAddKeyframeAtPlayhead,
  familyRequest,
}: EffectsPanelProps) {
  const selectionId = useSelectedOverlay(selectionStore);
  const selectedKeyframe = useSelectedKeyframe(keyframeSelectionStore);
  const { effectsLastPhase, setEffectsLastPhase, effectsPanelHeight, setEffectsPanelHeight } =
    useEditorState();
  const dragStart = useRef<{ y: number; h: number } | null>(null);
  const queryClient = useQueryClient();

  const onHandleDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragStart.current = { y: e.clientY, h: effectsPanelHeight };
  };
  const onHandleMove = (e: React.PointerEvent) => {
    if (!dragStart.current) return;
    // panel grows when dragging UP (handle is on the top edge): delta = startY - clientY
    setEffectsPanelHeight(dragStart.current.h + (dragStart.current.y - e.clientY));
  };
  const onHandleUp = (e: React.PointerEvent) => {
    dragStart.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState<Family>("animation");
  const apply = useApplyLayerEffect(pieceId);
  const clear = useClearLayerEffect(pieceId);
  const highlight = useEffectHighlightValue(effectHighlightStore);
  const { data: customData } = useCustomEffects();

  const customIds = useMemo(
    () => new Set((customData?.custom ?? []).map((c) => c.meta.id)),
    [customData],
  );

  const layer = useMemo(() => selectedLayer(selectionId, composition), [selectionId, composition]);
  const isText = layer?.kind === "text";

  // Resolve the selected layer's absolute [start, duration] (seconds) for the
  // effect-preview-on-select playback. Overlays and audio clips carry
  // startTime/duration directly. Scenes are out of scope (no absolute offset on
  // the layer object) → no preview.
  const resolveElementTiming = useCallback((): { start: number; duration: number } | null => {
    if (!layer || !composition) return null;
    const ov = composition.overlays?.find((o) => o.id === layer.layerId);
    if (ov) return { start: ov.startTime, duration: ov.duration };
    const clip = composition.audioClips?.find((c) => c.id === layer.layerId);
    if (clip) return { start: clip.startTime, duration: clip.duration };
    return null;
  }, [layer, composition]);

  const phases = layer ? phasesForKind(layer.kind) : (["in", "out", "loop"] as EffectPhase[]);
  const phase: EffectPhase = phases.includes(effectsLastPhase) ? effectsLastPhase : phases[0];

  // Animation-family effects for this kind+phase — text-internal reveals are
  // EXCLUDED here (they live in the Reveal family now). Plain derivation
  // (listEffects is a cheap registry lookup); the React Compiler memoizes it.
  const kindEffects = layer
    ? listEffects({ kind: layer.kind, phase }).filter((e) => !e.meta.textInternal)
    : [];

  const customAvailable = kindEffects.some((e) => customIds.has(e.meta.id));
  const revealAvailable = !!isText;

  // The overlay record for the selected layer (needed by the curve editor).
  const selectedOverlay = useMemo(
    () => composition?.overlays?.find((o) => o.id === layer?.layerId) ?? null,
    [composition, layer],
  );
  // The Keyframes family is available for any non-audio/non-scene overlay layer.
  // (Scenes/audio have no overlay keyframes; the tab is hidden for them.)
  const keyframesAvailable = !!selectedOverlay;

  // Auto-open the Keyframes tab when a keyframe diamond is newly selected (or a
  // keyframe was just added → selection becomes non-null). Non-intrusive: we
  // only switch ON a NEW selection, never force the tab back when the user
  // navigates away. Keyed on the selection identity (overlayId+t).
  const selKey = keyframeSelectionKey(selectedKeyframe) || null;
  // Previous-state pattern (render-time, pre-paint): fires on every CHANGE of
  // the selection key — including on mount with a selection already present —
  // exactly the edges the old ref+effect pair reacted to.
  const [prevSelKey, setPrevSelKey] = useState<string | null>(null);
  if (selKey !== prevSelKey) {
    setPrevSelKey(selKey);
    if (selKey) setFamily("keyframes");
  }

  // Honor an external "open on this family" request (e.g. inspector Reveal row).
  // Keyed on the nonce so the same family can be requested twice; never re-opens
  // a closed panel by itself (the panel must already be rendered to receive it).
  const [prevFamilyNonce, setPrevFamilyNonce] = useState<number | null>(null);
  if (familyRequest && familyRequest.nonce !== prevFamilyNonce) {
    setPrevFamilyNonce(familyRequest.nonce);
    setFamily(familyRequest.family);
  }

  // Resolve the active family, falling back to Animations when the requested
  // family isn't available for this layer kind.
  const activeFamily: Family =
    family === "keyframes" && keyframesAvailable
      ? "keyframes"
      : family === "custom" && customAvailable
        ? "custom"
        : family === "reveal" && revealAvailable
          ? "reveal"
          : "animation";

  // Plain derivation (cheap filter over a small registry list); the React
  // Compiler memoizes it together with `kindEffects` above.
  const searchQ = query.trim().toLowerCase();
  const effects = kindEffects.filter((e) => {
    if (activeFamily === "custom" && !customIds.has(e.meta.id)) return false;
    return !searchQ || e.meta.name.toLowerCase().includes(searchQ) || e.meta.id.includes(searchQ);
  });

  const activeEffectId = layer?.effects?.[phase]?.effectId;

  // ── Reveal family write (PATCHes overlay.reveal; SSE refetches composition) ──
  const setReveal = async (reveal: Record<string, unknown> | null) => {
    if (!layer || readOnly) return;
    await fetch(`/api/pieces/${pieceId}/overlays/${layer.layerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reveal }),
    }).catch(() => {});
    queryClient.invalidateQueries({ queryKey: pieceKeys.composition(pieceId) });
    // Preview the reveal on select (real mode only — not cleared / not "none").
    const mode = reveal?.mode;
    if (reveal && mode && mode !== "none") {
      const t = resolveElementTiming();
      const win = t
        ? effectPreviewWindowSec({ elementStart: t.start, elementDuration: t.duration, family: "reveal" })
        : null;
      if (win) {
        trackEvent("effect_previewed", { family: "reveal" });
        effectPreviewStore.request(win);
      }
    }
  };

  const currentMode = layer?.reveal?.mode ?? "none";

  return (
    <div
      data-testid="effects-panel"
      style={{ height: effectsPanelHeight }}
      className="relative flex min-h-0 flex-col gap-2 border-t border-border bg-surface px-4 py-3"
    >
      <div
        data-testid="effects-panel-resize"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        className="absolute inset-x-0 -top-1 z-10 h-2 cursor-ns-resize"
        role="separator"
        aria-orientation="horizontal"
      />
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold">Effects</span>
        <div className="relative ml-2 flex-1 max-w-48">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="w-full rounded bg-black/30 py-1 pl-7 pr-2 text-xs outline-none"
          />
        </div>
        <button
          type="button"
          data-testid="effects-panel-close"
          onClick={onClose}
          className="cursor-pointer rounded p-1 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {/* Family tabs */}
      <div className="flex items-center gap-1">
        {FAMILY_TABS.map((f) => {
          const enabled =
            f.id === "custom"
              ? customAvailable
              : f.id === "reveal"
                ? revealAvailable
                : f.id === "keyframes"
                  ? keyframesAvailable
                  : true;
          if (!enabled) return null; // hide unavailable families (no dead placeholders)
          const isActive = activeFamily === f.id;
          return (
            <button
              key={f.id}
              type="button"
              data-testid={`effects-family-${f.id}`}
              onClick={() => setFamily(f.id as Family)}
              className={`cursor-pointer rounded px-2 py-0.5 text-[11px] transition-colors ${
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "bg-primary/20 text-primary hover:bg-primary/30"
              }`}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {!layer ? (
        <p className="py-6 text-center text-xs text-muted-foreground">Select a layer to add an effect.</p>
      ) : activeFamily === "keyframes" && selectedOverlay ? (
        <KeyframesTab
          pieceId={pieceId}
          overlay={selectedOverlay}
          fps={composition?.fps ?? 30}
          selectedT={
            selectedKeyframe && selectedKeyframe.overlayId === selectedOverlay.id
              ? selectedKeyframe.t
              : null
          }
          onSelect={(t) => keyframeSelectionStore.set({ overlayId: selectedOverlay.id, t })}
          onAddKeyframeAtPlayhead={() => onAddKeyframeAtPlayhead(selectedOverlay.id)}
          readOnly={readOnly}
        />
      ) : activeFamily === "reveal" ? (
        <RevealFamily
          currentMode={currentMode}
          reveal={layer.reveal}
          isThreeD={!!layer.isThreeD}
          readOnly={readOnly}
          onPick={setReveal}
        />
      ) : (
        <>
          {/* Phase sub-filters */}
          <div className="flex items-center gap-1">
            {phases.map((p) => (
              <button
                key={p}
                type="button"
                data-testid={`effects-phase-${p}`}
                onClick={() => setEffectsLastPhase(p)}
                className={`cursor-pointer rounded px-2 py-0.5 text-[11px] font-medium capitalize transition-colors ${
                  phase === p ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {p}
              </button>
            ))}
          </div>

          {/* Grid */}
          <div className="grid min-h-0 flex-1 content-start auto-rows-min grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-1.5 overflow-y-auto p-0.5">
            {/* None tile (clears the slot). Mirrors EffectThumbnail's box model
                (p-1.5 + an h-12 preview box + label) so it matches the effect
                tiles' width AND height exactly — it used to be a fixed h-[68px],
                which rendered shorter than the taller thumbnails beside it. */}
            <button
              type="button"
              data-testid="effect-none"
              disabled={readOnly || !activeEffectId}
              onClick={() => clear.mutate({ layerId: layer.layerId, phase })}
              className={`group flex cursor-pointer flex-col items-stretch gap-1 rounded-md bg-surface p-1.5 transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50 ${
                !activeEffectId ? "ring-2 ring-inset ring-primary" : "ring-1 ring-inset ring-border"
              }`}
            >
              <div className="relative flex h-12 items-center justify-center overflow-hidden rounded bg-black/30">
                <span className="text-base text-muted-foreground">∅</span>
              </div>
              <span className="truncate text-center text-[10px] leading-tight text-muted-foreground group-hover:text-foreground">
                None
              </span>
            </button>
            {effects.map((effect) => (
              <EffectThumbnail
                key={effect.meta.id}
                effect={effect}
                phase={phase}
                sampleKind={layer.kind}
                isCustom={customIds.has(effect.meta.id)}
                selected={activeEffectId === effect.meta.id}
                highlighted={
                  highlight?.kind === "catalog" &&
                  highlight.effectId === effect.meta.id &&
                  (highlight.phase === undefined || highlight.phase === phase)
                }
                disabled={readOnly}
                onClick={() => {
                  apply.mutate({ layerId: layer.layerId, phase, effectId: effect.meta.id });
                  // Preview the selected effect's own window on the canvas.
                  const t = resolveElementTiming();
                  if (!t) return;
                  const existing = layer.effects?.[phase];
                  const durationMs =
                    existing?.effectId === effect.meta.id ? existing.durationMs : undefined;
                  const win = effectPreviewWindowSec({
                    elementStart: t.start,
                    elementDuration: t.duration,
                    family: "animation",
                    phase,
                    durationMs,
                    defaultDurationMs: effect.meta.defaultDurationMs,
                  });
                  if (win) {
                    trackEvent("effect_previewed", { family: "animation" });
                    effectPreviewStore.request(win);
                  }
                }}
              />
            ))}
          </div>
          {readOnly && (
            <p className="text-center text-[10px] text-muted-foreground">Snapshot view — read-only.</p>
          )}
        </>
      )}
    </div>
  );
}

/** One Reveal mode card: animated preview + label + hint. Module-scope (stable
 *  identity) so its hover/rAF state never remounts on the parent's re-render. */
function RevealCard({
  def,
  selected,
  enabled,
  disabledReason,
  highlightColor,
  onPick,
}: {
  def: RevealModeDef;
  selected: boolean;
  enabled: boolean;
  /** Why this card is disabled (shown as a hover tooltip), or null when enabled. */
  disabledReason: string | null;
  highlightColor: string;
  onPick: (def: RevealModeDef) => void;
}) {
  const [hover, setHover] = useState(false);
  // When disabled we DON'T use the native `disabled` attribute — a disabled
  // button receives no pointer events, so its `title` tooltip never shows. We
  // keep it interactive (aria-disabled + a no-op click) so hovering surfaces the
  // disabled-reason tooltip explaining how to enable it.
  return (
    <button
      type="button"
      data-testid={`reveal-mode-${def.mode}`}
      aria-disabled={!enabled}
      onClick={() => enabled && onPick(def)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      title={enabled ? def.hint : (disabledReason ?? def.hint)}
      className={`flex flex-col items-stretch gap-1 rounded-md p-2 text-left ring-1 ring-inset transition-colors ${
        selected ? "bg-primary/15 ring-primary" : "bg-surface ring-border hover:bg-surface-hover"
      } ${enabled ? "cursor-pointer" : "cursor-not-allowed opacity-40"}`}
    >
      <RevealThumbnail mode={def.mode} highlightColor={highlightColor} active={enabled && (hover || selected)} />
      <span className="text-[11px] font-medium text-foreground">{def.label}</span>
      <span className="line-clamp-2 text-[10px] leading-tight text-muted-foreground">{def.hint}</span>
    </button>
  );
}

/** The distinct, full-width "None" card — clears the reveal. Styled apart from
 *  the animated mode cards (no preview box): a single row with a ∅ glyph + label
 *  and the explanation beneath it. */
function RevealNoneCard({ selected, onPick }: { selected: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      data-testid="reveal-mode-none"
      onClick={onPick}
      title="No reveal — the caption is shown all at once."
      className={`flex w-full cursor-pointer flex-col gap-0.5 rounded-md border border-dashed p-2 text-left transition-colors ${
        selected
          ? "border-primary bg-primary/15"
          : "border-border bg-surface/60 hover:bg-surface-hover"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-base leading-none text-muted-foreground">∅</span>
        <span className="text-[11px] font-medium text-foreground">None</span>
      </div>
      <span className="text-[10px] leading-tight text-muted-foreground">
        No reveal — the whole caption is shown at once.
      </span>
    </button>
  );
}

/**
 * The Reveal family — a single-select list of text word-reveal modes over
 * `overlay.reveal`. 2D modes are disabled when the caption is 3D and the 3D-only
 * "Paint-on" mode is shown in its own section (disabled when the caption is 2D).
 * The selected mode's params (karaoke → color, paint-on → direction + angle)
 * render inline.
 */
function RevealFamily({
  currentMode,
  reveal,
  isThreeD,
  readOnly,
  onPick,
}: {
  currentMode: string;
  reveal: TextOverlay["reveal"];
  isThreeD: boolean;
  readOnly: boolean;
  onPick: (reveal: Record<string, unknown> | null) => void;
}) {
  // `none` renders as its own distinct full-width card (below); the animated
  // mode cards fill a responsive grid.
  const flat = REVEAL_MODES.filter((m) => m.dim !== "3d" && m.mode !== "none");
  const spatial = REVEAL_MODES.filter((m) => m.dim === "3d");

  const pick = (def: RevealModeDef) => {
    if (def.mode === "none") {
      onPick(null);
      return;
    }
    // Carry existing params + each param's default so the mode renders correctly.
    const next: Record<string, unknown> = { ...(reveal ?? {}), mode: def.mode };
    for (const p of def.params) {
      if (next[p.key] === undefined) next[p.key] = p.default;
    }
    onPick(next);
  };

  const setParam = (key: string, value: unknown) => {
    if (!reveal) return;
    onPick({ ...reveal, [key]: value });
  };

  const highlightColor = (reveal?.highlightColor as string) ?? "#ffd700";
  const selectedDef = REVEAL_MODES.find((m) => m.mode === currentMode);

  return (
    <div
      className="@container flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-0.5"
      data-testid="reveal-family"
    >
      {/* None — distinct full-width card with its explanation. */}
      <RevealNoneCard selected={currentMode === "none"} onPick={() => !readOnly && onPick(null)} />

      {/* Animated mode cards — 3 across when there's room, then 2, then 1. */}
      <div className="grid grid-cols-1 gap-1.5 @[260px]:grid-cols-2 @[400px]:grid-cols-3">
        {flat.map((def) => (
          <RevealCard
            key={def.mode}
            def={def}
            selected={currentMode === def.mode}
            enabled={isRevealModeEnabled(def, isThreeD) && !readOnly}
            disabledReason={revealDisabledReason(def, isThreeD)}
            highlightColor={highlightColor}
            onPick={pick}
          />
        ))}
      </div>

      {/* 3D section — only meaningful when the caption is 3D. */}
      {spatial.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="mt-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            3D {!isThreeD && <span className="font-normal normal-case opacity-70">— make the caption 3D to use</span>}
          </div>
          <div className="grid grid-cols-1 gap-1.5 @[260px]:grid-cols-2 @[400px]:grid-cols-3">
            {spatial.map((def) => (
              <RevealCard
                key={def.mode}
                def={def}
                selected={currentMode === def.mode}
                enabled={isRevealModeEnabled(def, isThreeD) && !readOnly}
                disabledReason={revealDisabledReason(def, isThreeD)}
                highlightColor={highlightColor}
                onPick={pick}
              />
            ))}
          </div>
        </div>
      )}

      {/* Inline params for the selected reveal mode. */}
      {selectedDef && selectedDef.params.length > 0 && (
        <div className="mt-1 flex flex-col gap-1.5 border-t border-border pt-2" data-testid="reveal-params">
          {selectedDef.params.map((p) => {
            if (p.type === "color") {
              const value = (reveal?.[p.key as keyof typeof reveal] as string) ?? p.default;
              return (
                <label key={p.key} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-muted-foreground">{p.label}</span>
                  <input
                    type="color"
                    data-testid={`reveal-param-${p.key}`}
                    disabled={readOnly}
                    value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#ffd700"}
                    onChange={(e) => setParam(p.key, e.target.value)}
                    className="h-5 w-8 cursor-pointer rounded border border-border bg-background"
                  />
                </label>
              );
            }
            if (p.type === "enum") {
              const value = (reveal?.[p.key as keyof typeof reveal] as string) ?? p.default;
              return (
                <label key={p.key} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-muted-foreground">{p.label}</span>
                  <select
                    data-testid={`reveal-param-${p.key}`}
                    disabled={readOnly}
                    value={value}
                    onChange={(e) => setParam(p.key, e.target.value)}
                    className="cursor-pointer rounded border border-border bg-background px-1.5 py-0.5 text-xs"
                  >
                    {p.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              );
            }
            // number
            const value = (reveal?.[p.key as keyof typeof reveal] as number) ?? p.default;
            return (
              <div key={p.key} data-testid={`reveal-param-${p.key}`}>
                <NumberSlider
                  label={p.label}
                  value={value}
                  min={p.min}
                  max={p.max}
                  step={p.step}
                  defaultValue={p.default}
                  onChange={(v) => setParam(p.key, v)}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
