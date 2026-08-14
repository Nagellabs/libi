// components/preview/effects-inspector.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, X, ChevronRight, ChevronDown } from "lucide-react";
import type { LayerEffects, EffectPhase, LayerKind, EffectRef, EffectDef } from "@/lib/effects/types";
import type { TextOverlay } from "@/lib/engine/types";
import { findEffect } from "@/lib/effects/registry";
import { TEXT_INTERNAL_EFFECT_IDS } from "@/lib/effects/builtin";
import { REVEAL_MODES } from "@/lib/captions/reveal-modes";
import { revealForTextInternal } from "@/lib/effects/text-internal-reveal";
import { RevealThumbnail } from "@/components/preview/reveal-thumbnail";
import { NumberInspectorField } from "@/components/preview/number-inspector-field";
import { useApplyLayerEffect, useClearLayerEffect, useClearReveal } from "@/lib/queries/effects";
import { effectRowSummary } from "@/lib/effects/row-summary";
import type { EffectsFamily } from "@/components/preview/effects-panel";
import { resolveThumbnailParams, deltaToThumbnailStyle, thumbnailProgress } from "@/lib/effects/thumbnail";
import {
  useEffectHighlightValue,
  type EffectHighlightStore,
} from "@/lib/preview/effect-highlight-store";

/**
 * A compact, auto-looping preview of an APPLIED effect — so the inspector shows
 * WHAT the effect does, not just its name. Audio envelopes get a representative
 * opacity pulse (their real gain path renders on the canvas); every other effect
 * runs its real `animate(progress)` as a CSS transform on a sample chip. Text
 * reveals are shown by a mode-faithful <RevealThumbnail> in the row instead of
 * this component. Always animating (no hover needed) so the applied effect is
 * legible at a glance.
 */
function AppliedEffectThumb({ def, kind }: { def: EffectDef; kind: LayerKind }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const params = useRef(resolveThumbnailParams(def.meta));
  const representative = def.meta.audioEnvelope;
  useEffect(() => {
    let raf = 0;
    let start = 0;
    const loop = (now: number) => {
      if (!start) start = now;
      const p = thumbnailProgress(now - start);
      const el = ref.current;
      if (el) {
        if (representative) {
          el.style.transform = "none";
          el.style.opacity = String(0.25 + 0.75 * p);
          el.style.filter = "none";
          el.style.clipPath = "none";
        } else {
          const s = deltaToThumbnailStyle(def.animate(p, params.current));
          el.style.transform = s.transform;
          el.style.opacity = String(s.opacity);
          el.style.filter = s.filter;
          el.style.clipPath = s.clipPath;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [def, representative]);

  const sample =
    kind === "text" ? (
      <div ref={ref} className="text-[10px] font-semibold text-white">Aa</div>
    ) : kind === "audio" ? (
      <div ref={ref} className="flex h-3 items-end gap-px">
        {[3, 6, 4, 7, 5].map((h, i) => (
          <span key={i} className="w-0.5 rounded-sm bg-emerald-400" style={{ height: `${h * 1.2}px` }} />
        ))}
      </div>
    ) : (
      <div ref={ref} className="size-3.5 rounded bg-gradient-to-br from-sky-400 to-indigo-500" />
    );

  return (
    <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded bg-black/30">
      {sample}
    </span>
  );
}

/** Phase glyphs + colors — a tiny mono badge per row. `reveal` is the text
 *  word-reveal pseudo-phase (`Aa`). */
const PHASE_GLYPH: Record<string, { glyph: string; cls: string }> = {
  in: { glyph: "⇤", cls: "text-emerald-400" },
  out: { glyph: "⇥", cls: "text-orange-400" },
  loop: { glyph: "⟳", cls: "text-sky-400" },
  reveal: { glyph: "Aa", cls: "text-violet-400" },
};

function PhaseGlyph({ phase }: { phase: string }) {
  const g = PHASE_GLYPH[phase] ?? { glyph: "•", cls: "text-muted-foreground" };
  return <span className={`w-4 flex-none text-center text-[10px] ${g.cls}`}>{g.glyph}</span>;
}

interface EffectsInspectorProps {
  pieceId: string;
  layerId: string;
  kind: LayerKind;
  effects: LayerEffects | undefined;
  /** The text overlay's word reveal (karaoke/typewriter/…). Shown as its OWN row,
   *  independent of the `effects` in/out/loop slots, so a reveal AND a box
   *  animation both appear at once. Undefined for non-text layers. */
  reveal?: TextOverlay["reveal"];
  effectHighlightStore: EffectHighlightStore;
  onOpenPicker: (family?: EffectsFamily) => void;
  readOnly: boolean;
}

function phasesForKind(kind: LayerKind): EffectPhase[] {
  return kind === "audio" ? ["in", "out"] : ["in", "out", "loop"];
}

export function EffectsInspector({
  pieceId,
  layerId,
  kind,
  effects,
  reveal,
  effectHighlightStore,
  onOpenPicker,
  readOnly,
}: EffectsInspectorProps) {
  const apply = useApplyLayerEffect(pieceId);
  const clear = useClearLayerEffect(pieceId);
  const clearRevealMutation = useClearReveal(pieceId);
  const highlight = useEffectHighlightValue(effectHighlightStore);

  // Independent per-row expansion toggles, all collapsed by default, reset when
  // the inspected layer changes.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // Collapse all rows on the render where the inspected layer changes
  // (previous-state pattern — pre-paint, no effect cascade).
  const [prevLayerId, setPrevLayerId] = useState(layerId);
  if (layerId !== prevLayerId) {
    setPrevLayerId(layerId);
    setOpen({});
  }
  const toggle = (phase: string) => setOpen((o) => ({ ...o, [phase]: !o[phase] }));

  const reApply = (phase: EffectPhase, ref: EffectRef, patch: Partial<EffectRef>) => {
    apply.mutate({
      layerId,
      phase,
      effectId: ref.effectId,
      durationMs: patch.durationMs ?? ref.durationMs,
      params: { ...(ref.params ?? {}), ...(patch.params ?? {}) },
    });
  };

  // Clearing a text-internal reveal mirror (karaoke/typewriter/…) must clear the
  // OVERLAY'S `reveal` — the real source of truth — not just the `effects.in`
  // mirror. Clearing the mirror alone doesn't stick: it's re-derived from
  // `reveal` on the next load (the "can't remove a reveal" bug). The reveal PATCH
  // also strips the persisted mirror (saveManifest), so this fully removes it.
  const clearReveal = () => clearRevealMutation.mutate({ layerId });

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-muted-foreground">Effects</span>
        <button
          type="button"
          data-testid="inspector-effects"
          onClick={() => onOpenPicker()}
          className="flex cursor-pointer items-center gap-1 rounded bg-surface px-2 py-1 text-[11px] hover:bg-surface-hover"
        >
          <Sparkles className="size-3" /> Effects & Keyframes
        </button>
      </div>

      {/* Reveal row — the text word-reveal (karaoke/typewriter/…), shown as its
          OWN entry from `overlay.reveal`, INDEPENDENT of the in/out/loop effect
          slots. This is what makes a reveal AND a box animation both appear at
          once (the reveal was invisible whenever a real `effects.in` occupied the
          slot the hydrate mirror would otherwise use). NOT expandable — reveal
          timing is word-/progress-driven, configured in the Reveal tab; the row
          header opens the picker on the Reveal tab. */}
      {reveal && reveal.mode !== "none" && (() => {
        const label = REVEAL_MODES.find((m) => m.mode === reveal.mode)?.label ?? reveal.mode;
        return (
          <div data-testid="effect-slot-reveal" className="rounded bg-black/20">
            <div
              data-testid="effect-row-toggle-reveal"
              role="button"
              tabIndex={0}
              onClick={() => onOpenPicker("reveal")}
              className="flex w-full cursor-pointer items-center gap-2 p-1.5 text-left"
            >
              <PhaseGlyph phase="reveal" />
              <RevealThumbnail mode={reveal.mode} active compact />
              <span className="min-w-0 flex-1 truncate text-xs font-semibold">
                {label}
                <span className="ml-1 font-normal text-muted-foreground">· reveal · word-timed</span>
              </span>
              {!readOnly && (
                <button
                  type="button"
                  aria-label="Remove reveal"
                  onClick={(e) => {
                    e.stopPropagation();
                    clearReveal();
                  }}
                  className="flex-none cursor-pointer text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {phasesForKind(kind)
        // Real box animations only — the text-internal reveal MIRROR (karaoke/
        // typewriter/…) is shown by the dedicated Reveal row above, never as a
        // duplicate in/out slot.
        .filter((phase) => effects?.[phase] && !TEXT_INTERNAL_EFFECT_IDS.has(effects[phase]!.effectId))
        .map((phase) => {
        const ref = effects![phase]!;
        const def = findEffect(ref.effectId);
        const flashed =
          highlight?.kind === "applied" && highlight.layerId === layerId && highlight.phase === phase;
        // Any editable animation row is expandable — its param block always
        // includes Duration, so there's always something to disclose.
        const expandable = !readOnly;
        const expanded = expandable && !!open[phase];
        const name = def?.meta.name ?? "—";
        const summary = def ? effectRowSummary(def, ref, phase) : phase;
        return (
          <div
            key={phase}
            data-testid={`effect-slot-${phase}`}
            data-highlight={flashed ? "true" : undefined}
            className={`rounded bg-black/20 ${flashed ? "ring-2 ring-amber-400" : ""}`}
          >
            <div
              data-testid={`effect-row-toggle-${phase}`}
              role="button"
              tabIndex={expandable ? 0 : undefined}
              onClick={expandable ? () => toggle(phase) : undefined}
              className={`flex w-full items-center gap-2 p-1.5 text-left ${expandable ? "cursor-pointer" : ""}`}
            >
              <PhaseGlyph phase={phase} />
              {/* Live preview of the applied effect (see the effect at a glance).
                  A text-internal def (belt-and-braces — the phase loop already
                  filters reveal mirrors) shows its mode-faithful reveal thumb. */}
              {def &&
                (def.meta.textInternal ? (
                  <RevealThumbnail
                    mode={revealForTextInternal(def.meta.id)?.mode ?? "none"}
                    active
                    compact
                  />
                ) : (
                  <AppliedEffectThumb def={def} kind={kind} />
                ))}
              <span className="min-w-0 flex-1 truncate text-xs font-semibold">
                {name}
                <span className="ml-1 font-normal text-muted-foreground">· {summary}</span>
              </span>
              {expandable &&
                (expanded ? (
                  <ChevronDown className="size-3 flex-none text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3 flex-none text-muted-foreground" />
                ))}
              {!readOnly && (
                <button
                  type="button"
                  aria-label={`Clear ${phase}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    clear.mutate({ layerId, phase });
                  }}
                  className="flex-none cursor-pointer text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>

            {expanded && def && (
              <div className="flex flex-col gap-1 border-t border-border/50 p-1.5">
                <NumberInspectorField
                  label="Duration"
                  value={ref.durationMs ?? def.meta.defaultDurationMs ?? 400}
                  suffix="ms"
                  testId={`effect-${phase}-duration`}
                  onCommit={(v) => reApply(phase, ref, { durationMs: Math.max(50, v) })}
                />
                {def.meta.params.map((p) =>
                  p.type === "number" ? (
                    <NumberInspectorField
                      key={p.key}
                      label={p.label}
                      value={Number(ref.params?.[p.key] ?? p.default ?? 0)}
                      testId={`effect-${phase}-${p.key}`}
                      onCommit={(v) => reApply(phase, ref, { params: { [p.key]: v } })}
                    />
                  ) : (
                    <label key={p.key} className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="text-muted-foreground">{p.label}</span>
                      <select
                        data-testid={`effect-${phase}-${p.key}`}
                        value={String(ref.params?.[p.key] ?? p.default ?? p.options?.[0] ?? "")}
                        onChange={(e) => reApply(phase, ref, { params: { [p.key]: e.target.value } })}
                        className="cursor-pointer rounded bg-black/30 px-1.5 py-0.5 text-xs outline-none"
                      >
                        {(p.options ?? []).map((o) => (
                          <option key={o} value={o}>{o}</option>
                        ))}
                      </select>
                    </label>
                  ),
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
