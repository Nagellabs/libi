"use client";

import { useState } from "react";

import {
  useApplyPreset,
  useDeletePreset,
  useOverlayPresets,
  useSavePreset,
} from "@/lib/queries/overlay-presets";
import { matchPreset, type OverlayPreset } from "@/lib/overlays/presets";
import type { Overlay } from "@/lib/engine/types";

/**
 * PresetRow — a reusable inspector chip row for overlay style presets.
 *
 * Lists bundled + user-saved presets for the overlay's kind, applies one on
 * click, badges the chip that currently matches the overlay, lets the user save
 * the current look as a new named preset, and delete user-saved presets.
 *
 * Presentational + hook-driven: no local optimistic state beyond the inline
 * save-name input. Mutations invalidate the relevant queries on success (in the
 * hooks themselves).
 */
export function PresetRow({
  overlay,
  pieceId,
}: {
  overlay: Overlay;
  pieceId: string;
}) {
  const { data } = useOverlayPresets(overlay.kind);
  const presets: OverlayPreset[] = (data as OverlayPreset[] | undefined) ?? [];
  const apply = useApplyPreset(pieceId);
  const save = useSavePreset();
  const del = useDeletePreset();

  // matchPreset wants a record-shaped overlay; the runtime Overlay is one.
  const activeId = matchPreset(
    overlay as unknown as Record<string, unknown> & { kind: string },
    presets,
  );
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  function commitSave() {
    const trimmed = name.trim();
    if (trimmed) {
      save.mutate({ pieceId, overlayId: overlay.id, name: trimmed });
    }
    setName("");
    setNaming(false);
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {presets.map((p) => {
        const active = p.id === activeId;
        return (
          <span key={p.id} className="relative inline-flex">
            <button
              type="button"
              data-preset={p.id}
              data-active={active ? "true" : undefined}
              aria-pressed={active}
              onClick={() =>
                apply.mutate({ overlayId: overlay.id, presetId: p.id, kind: overlay.kind })
              }
              title={p.name}
              className={`flex cursor-pointer items-center gap-1 rounded border px-2 py-1 text-[11px] transition-colors ${
                active
                  ? "border-primary bg-primary/15 text-foreground ring-1 ring-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {overlay.kind === "text" ? (
                <span
                  aria-hidden
                  className="text-[12px] font-bold leading-none"
                  style={presetSwatchStyle(p)}
                >
                  Aa
                </span>
              ) : null}
              {p.name}
            </button>
            {p.source === "user" ? (
              <button
                type="button"
                data-preset-delete={p.id}
                title={`Delete ${p.name}`}
                aria-label={`Delete ${p.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  del.mutate(p.id);
                }}
                className="ml-0.5 flex cursor-pointer items-center justify-center rounded border border-border px-1 text-[11px] text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            ) : null}
          </span>
        );
      })}

      {naming ? (
        <input
          type="text"
          autoFocus
          value={name}
          placeholder="Preset name"
          onChange={(e) => setName(e.target.value)}
          onBlur={commitSave}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitSave();
            if (e.key === "Escape") {
              setName("");
              setNaming(false);
            }
          }}
          className="w-24 rounded border border-border bg-background px-1.5 py-1 text-[11px] text-foreground"
        />
      ) : (
        <button
          type="button"
          data-testid="save-preset"
          title="Save preset"
          onClick={() => setNaming(true)}
          className="cursor-pointer rounded border border-dashed border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          + Save preset
        </button>
      )}
    </div>
  );
}

/** A best-effort "Aa" swatch style derived from a text preset's pinned fields. */
function presetSwatchStyle(preset: OverlayPreset): React.CSSProperties {
  const fields = preset.fields as {
    color?: string;
    stroke?: { color?: string };
  };
  const style: React.CSSProperties = { color: fields.color ?? "#ffffff" };
  if (fields.stroke?.color) {
    (style as Record<string, string>).WebkitTextStrokeWidth = "0.5px";
    (style as Record<string, string>).WebkitTextStrokeColor = fields.stroke.color;
  }
  return style;
}
