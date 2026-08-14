"use client";

import { useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import type { Composition, Overlay } from "@/lib/engine/types";
import type { EffectPhase, LayerKind } from "@/lib/effects/types";
import { listEffects } from "@/lib/effects/registry";
import { useApplyLayerEffect } from "@/lib/queries/effects";
import { useOverlayTransformCommit } from "@/hooks/editor/use-overlay-transform-commit";
import { useOverlayEditStore } from "@/lib/preview/overlay-edit-context";

interface BatchStyleBarProps {
  pieceId: string;
  composition: Composition | null;
  /** The multi-selection (length > 1 is enforced by the caller). */
  selectedIds: string[];
  /** Snapshot view → controls are read-only. */
  readOnly?: boolean;
}

/**
 * Batch-style bar — shown only when more than one overlay is selected. Applies
 * a style change across the WHOLE selection by looping the EXISTING single-item
 * mutations (no bulk MCP tool). Scope (YAGNI): opacity (all kinds), text color
 * (only when every selected overlay is text), and one effect.
 */
export function BatchStyleBar({
  pieceId,
  composition,
  selectedIds,
  readOnly = false,
}: BatchStyleBarProps) {
  const overlayEditStore = useOverlayEditStore();
  const { commit, flush } = useOverlayTransformCommit(pieceId, overlayEditStore);
  const applyEffect = useApplyLayerEffect(pieceId);

  // Resolve the selected overlays (skip any id that isn't an overlay — scenes /
  // audio clips share the selection string space but can't be batch-styled here).
  const selected: Overlay[] = useMemo(() => {
    const byId = new Map((composition?.overlays ?? []).map((o) => [o.id, o] as const));
    return selectedIds.map((id) => byId.get(id)).filter((o): o is Overlay => Boolean(o));
  }, [composition, selectedIds]);

  const allText = selected.length > 0 && selected.every((o) => o.kind === "text");

  // Effects supported by EVERY selected kind, for the chosen phase.
  const [phase, setPhase] = useState<EffectPhase>("in");
  const effectOptions = useMemo(() => {
    const kinds = new Set<LayerKind>(selected.map((o) => o.kind as LayerKind));
    return listEffects({ phase }).filter((e) =>
      [...kinds].every((k) => e.meta.supports.includes(k)),
    );
  }, [selected, phase]);

  const [effectId, setEffectId] = useState<string>("");
  const effectiveEffectId = effectId || effectOptions[0]?.meta.id || "";

  const [opacity, setOpacity] = useState<number>(100);
  const [color, setColor] = useState<string>("#ffffff");
  const [pending, setPending] = useState<null | "opacity" | "color" | "effect">(null);

  const runAcross = async (
    label: "opacity" | "color" | "effect",
    fn: (id: string) => void | Promise<unknown>,
  ) => {
    if (readOnly || pending) return;
    setPending(label);
    try {
      await Promise.all(selected.map((o) => Promise.resolve(fn(o.id))));
    } finally {
      setPending(null);
    }
  };

  // Apply the edit to the store (instant paint) then flush it to persist NOW —
  // these are deliberate one-shot batch actions, not interactive drags, so we
  // skip the debounce.
  const applyOpacity = () =>
    runAcross("opacity", (id) => {
      commit(id, { opacity: Math.max(0, Math.min(1, opacity / 100)) });
      flush(id);
    });

  const applyColor = () =>
    runAcross("color", (id) => {
      commit(id, { color });
      flush(id);
    });

  const applyTheEffect = () => {
    if (!effectiveEffectId) return;
    return runAcross("effect", (id) =>
      applyEffect.mutateAsync({ layerId: id, phase, effectId: effectiveEffectId }),
    );
  };

  return (
    <div
      className="flex flex-col gap-2 p-2"
      data-testid="batch-style-bar"
    >
      <div className="text-[11px] font-semibold text-foreground">
        {selected.length} overlays selected
      </div>

      {/* Opacity (all kinds) */}
      <div className="flex flex-col gap-1">
        <label className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>Opacity</span>
          <span className="font-mono text-foreground/90">{Math.round(opacity)}%</span>
        </label>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={100}
            value={opacity}
            data-testid="batch-opacity-slider"
            disabled={readOnly}
            onChange={(e) => setOpacity(Number(e.target.value))}
            className="flex-1 cursor-pointer"
          />
          <button
            type="button"
            data-testid="batch-opacity-apply"
            onClick={applyOpacity}
            disabled={readOnly || pending != null}
            className="cursor-pointer rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {pending === "opacity" ? "Applying…" : "Apply"}
          </button>
        </div>
      </div>

      {/* Color — text overlays only */}
      {allText && (
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-muted-foreground">Text color</label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={color}
              data-testid="batch-color-input"
              disabled={readOnly}
              onChange={(e) => setColor(e.target.value)}
              className="h-7 w-10 cursor-pointer rounded border border-border bg-transparent"
            />
            <button
              type="button"
              data-testid="batch-color-apply"
              onClick={applyColor}
              disabled={readOnly || pending != null}
              className="cursor-pointer rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {pending === "color" ? "Applying…" : "Apply"}
            </button>
          </div>
        </div>
      )}

      {/* Apply one effect across the selection */}
      <div className="flex flex-col gap-1 border-t border-border pt-2">
        <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
          <Sparkles className="size-3" /> Effect
        </div>
        <div className="flex items-center gap-2">
          <select
            value={phase}
            data-testid="batch-effect-phase"
            disabled={readOnly}
            onChange={(e) => setPhase(e.target.value as EffectPhase)}
            className="cursor-pointer rounded bg-black/30 px-1.5 py-1 text-[11px] outline-none"
          >
            <option value="in">In</option>
            <option value="out">Out</option>
            <option value="loop">Loop</option>
          </select>
          <select
            value={effectiveEffectId}
            data-testid="batch-effect-select"
            disabled={readOnly || effectOptions.length === 0}
            onChange={(e) => setEffectId(e.target.value)}
            className="min-w-0 flex-1 cursor-pointer rounded bg-black/30 px-1.5 py-1 text-[11px] outline-none disabled:opacity-50"
          >
            {effectOptions.length === 0 ? (
              <option value="">No shared effect</option>
            ) : (
              effectOptions.map((e) => (
                <option key={e.meta.id} value={e.meta.id}>
                  {e.meta.name}
                </option>
              ))
            )}
          </select>
          <button
            type="button"
            data-testid="batch-effect-apply"
            onClick={applyTheEffect}
            disabled={readOnly || pending != null || !effectiveEffectId}
            className="cursor-pointer rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {pending === "effect" ? "Applying…" : "Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}
