"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatRelativeTime } from "@/lib/utils/format";
import {
  useOverlayPresets,
  useSavePreset,
  useApplyPreset,
  useDeletePreset,
  PresetNameConflictError,
  type OverlayPreset,
} from "@/lib/queries/overlay-presets";
import type { Overlay } from "@/lib/engine/types";

/** Human label for an overlay kind (used in type tags + tooltips). */
const KIND_LABEL: Record<string, string> = {
  text: "Text",
  image: "Image",
  video: "Video",
  code: "Code",
  three: "3D",
  tracked: "Tracked",
};
function kindLabel(k: string): string {
  return KIND_LABEL[k] ?? k;
}

/** Compact relative time — shared with the recents list in the "No piece
 *  open" panel, which is where this implementation now lives. */
const formatRelative = formatRelativeTime;
/** Absolute timestamp for the row tooltip. */
function absTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}
/** The timestamp a preset sorts by (last update, falling back to creation). */
function sortTs(p: OverlayPreset): string {
  return p.updatedAt ?? p.createdAt ?? "";
}

/**
 * Dialog that manages full-overlay presets for the currently-inspected overlay.
 * A preset captures EVERYTHING about a layer (look, effects, transform,
 * position, rotation). Presets are kind-scoped: a preset can ONLY be applied to
 * a layer of the SAME kind. The dialog lists ALL saved presets (newest-updated
 * first) organized by type (with a per-type filter); presets of a different
 * kind than the current layer are shown but DISABLED (with a tooltip).
 */
export function OverlayPresetDialog({
  pieceId,
  overlay,
  open,
  onOpenChange,
}: {
  pieceId: string;
  overlay: Overlay;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  // Fetch ALL user presets (every kind) so they can be organized by type.
  const { data } = useOverlayPresets();
  const allPresets = ((data as OverlayPreset[] | undefined) ?? []).filter(
    (p) => p.source === "user",
  );
  const save = useSavePreset();
  const apply = useApplyPreset(pieceId);
  const del = useDeletePreset();
  const [name, setName] = useState("");
  // The name awaiting a replace-confirm (null = no pending conflict).
  const [conflict, setConflict] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Active type filter (null = show all kinds).
  const [filterKind, setFilterKind] = useState<string | null>(null);
  // The preset id awaiting a delete-confirm (null = none).
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const kindsPresent = Array.from(new Set(allPresets.map((p) => p.kind))).sort(
    (a, b) =>
      a === overlay.kind ? -1 : b === overlay.kind ? 1 : a.localeCompare(b),
  );
  const filtered = filterKind
    ? allPresets.filter((p) => p.kind === filterKind)
    : allPresets;
  // Sort by last update time (newest first); ISO strings sort chronologically.
  const shown = [...filtered].sort((a, b) => sortTs(b).localeCompare(sortTs(a)));

  function resetTransient() {
    setName("");
    setConflict(null);
    setError(null);
    setConfirmDeleteId(null);
  }

  async function doSave(override: boolean) {
    setError(null);
    try {
      await save.mutateAsync({ pieceId, overlayId: overlay.id, name, override });
      setName("");
      setConflict(null);
    } catch (e) {
      if (e instanceof PresetNameConflictError) {
        setConflict(e.presetName);
      } else {
        setError(e instanceof Error ? e.message : "Failed to save preset.");
      }
    }
  }

  function applyPreset(p: OverlayPreset) {
    apply.mutate(
      { overlayId: overlay.id, presetId: p.id, kind: overlay.kind },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) resetTransient();
        onOpenChange(o);
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Presets</DialogTitle>
          <DialogDescription>
            A preset saves EVERYTHING about this layer — look, effects, position,
            rotation — as a reusable template. You and the AI can apply it to any
            other {kindLabel(overlay.kind)} layer.
          </DialogDescription>
        </DialogHeader>

        {/* Save row */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setConflict(null);
                setError(null);
              }}
              placeholder="Preset name"
              aria-label="Preset name"
            />
            <Button
              type="button"
              onClick={() => doSave(false)}
              disabled={!name.trim() || save.isPending}
              className="cursor-pointer"
            >
              Save
            </Button>
          </div>
          {conflict && (
            <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 p-2 text-[12px]">
              <span className="text-muted-foreground">
                A preset named &ldquo;{conflict}&rdquo; already exists. Overwrite
                it?
              </span>
              <div className="flex shrink-0 gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => doSave(true)}
                  disabled={save.isPending}
                  className="cursor-pointer"
                >
                  Replace
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setConflict(null)}
                  className="cursor-pointer"
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {error && <p className="text-[12px] text-destructive">{error}</p>}
        </div>

        {/* Type filter — only when more than one kind is saved. */}
        {kindsPresent.length > 1 && (
          <div
            data-testid="preset-kind-filter"
            className="flex flex-wrap items-center gap-1"
          >
            <FilterChip
              active={filterKind === null}
              onClick={() => setFilterKind(null)}
              label="All"
            />
            {kindsPresent.map((k) => (
              <FilterChip
                key={k}
                active={filterKind === k}
                onClick={() => setFilterKind(k)}
                label={kindLabel(k)}
              />
            ))}
          </div>
        )}

        {/* Saved presets — newest-updated first, scrolls inside the dialog. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {shown.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-muted-foreground">
              {allPresets.length === 0
                ? "No saved presets yet. Name the current layer above to save one."
                : `No ${filterKind ? `${kindLabel(filterKind)} ` : ""}presets.`}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {shown.map((p) => {
                const applicable = p.kind === overlay.kind;
                const confirming = confirmDeleteId === p.id;
                return (
                  <li
                    key={p.id}
                    data-preset-id={p.id}
                    data-preset-kind={p.kind}
                    className="flex items-center gap-2 rounded-md border border-border bg-background/60"
                  >
                    <button
                      type="button"
                      // aria-disabled (not `disabled`) so the explain-why tooltip
                      // still fires on hover for a mismatched-kind preset.
                      aria-disabled={!applicable}
                      onClick={() => {
                        if (applicable && !apply.isPending) applyPreset(p);
                      }}
                      className={`flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-3 py-2 text-left ${
                        applicable
                          ? "cursor-pointer hover:bg-muted/60"
                          : "cursor-not-allowed opacity-60"
                      }`}
                      title={
                        applicable
                          ? `Apply "${p.name}" to this ${kindLabel(overlay.kind)} layer`
                          : `This is a ${kindLabel(p.kind)} preset — it can't be applied to a ${kindLabel(overlay.kind)} layer.`
                      }
                    >
                      <span className="flex items-center gap-1.5">
                        <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                          {kindLabel(p.kind)}
                        </span>
                        <span className="truncate text-[13px] font-medium text-foreground">
                          {p.name}
                        </span>
                      </span>
                      <span
                        className="text-[10px] text-muted-foreground"
                        title={`Updated ${absTime(p.updatedAt ?? p.createdAt)}\nCreated ${absTime(p.createdAt)}`}
                      >
                        Updated {formatRelative(p.updatedAt ?? p.createdAt)}
                        {" · "}Created {formatRelative(p.createdAt)}
                      </span>
                    </button>

                    {confirming ? (
                      <div className="flex shrink-0 items-center gap-1.5 pr-2 text-[11px]">
                        <span className="text-muted-foreground">
                          Delete forever?
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          className="h-7 cursor-pointer"
                          disabled={del.isPending}
                          onClick={() => {
                            del.mutate(p.id);
                            setConfirmDeleteId(null);
                          }}
                        >
                          Delete
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 cursor-pointer"
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="mr-2 h-7 shrink-0 cursor-pointer gap-1 text-muted-foreground hover:text-destructive"
                        aria-label={`Delete preset ${p.name}`}
                        title={`Delete "${p.name}"`}
                        onClick={() => setConfirmDeleteId(p.id)}
                      >
                        <Trash2 className="size-3.5" />
                        Delete
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A small pill toggle for the per-type preset filter. */
function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`cursor-pointer rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
        active
          ? "border-primary bg-primary/15 text-foreground"
          : "border-border text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}
