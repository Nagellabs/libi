"use client";

import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  ASPECT_RATIOS,
  dimensionsFor,
  nearestRatio,
  type AspectRatioOption,
  type Orientation,
} from "@/lib/composition/aspect-ratio";

const GROUPS: { orientation: Orientation; label: string }[] = [
  { orientation: "portrait", label: "Portrait" },
  { orientation: "square", label: "Square" },
  { orientation: "landscape", label: "Landscape" },
];

/** Height of the shape swatch box, in px. Widths derive from the ratio. */
const SWATCH_BOX = 44;

/**
 * The ratio picker.
 *
 * Each card draws its ratio as an actual rectangle rather than only naming it
 * — the shape is the information, and "4:5 vs 9:16" is far quicker to judge
 * by eye than by arithmetic.
 */
export function AspectRatioDialog({
  open,
  setOpen,
  currentWidth,
  currentHeight,
  overlayCount,
  onConfirm,
  busy,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  currentWidth: number;
  currentHeight: number;
  overlayCount: number;
  onConfirm: (target: AspectRatioOption) => void;
  busy?: boolean;
}) {
  const currentId = useMemo(
    () => nearestRatio(currentWidth, currentHeight)?.id ?? null,
    [currentWidth, currentHeight],
  );
  const [selectedId, setSelectedId] = useState<string | null>(currentId);
  // Whether the user has deliberately picked a card this time the dialog is
  // open. Until they do, the dialog tracks the piece's live ratio — an agent
  // resize while the dialog is open must not leave a stale selection that
  // silently enables the confirm button.
  const [touched, setTouched] = useState(false);

  // Reopening after the piece changed underneath (the agent can resize it)
  // must not show a stale selection. Render-time adjustment (React's
  // "adjusting state when a prop changes" pattern) rather than an effect, so
  // the reset applies in the same pass, effect-free.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setSelectedId(currentId);
      setTouched(false);
    }
  }

  const effectiveSelectedId = touched ? selectedId : currentId;
  const selected = ASPECT_RATIOS.find((r) => r.id === effectiveSelectedId) ?? null;
  const dims = selected ? dimensionsFor(selected.id) : { width: currentWidth, height: currentHeight };
  const changed = effectiveSelectedId !== null && effectiveSelectedId !== currentId;
  const hasContent = overlayCount > 0;
  const plural = overlayCount === 1 ? "1 overlay" : `${overlayCount} overlays`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Aspect ratio</DialogTitle>
          <DialogDescription>
            The frame your piece is built for. Affects the preview, the export, and
            the shape of AI-generated clips.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {GROUPS.map((group) => (
            <div key={group.orientation}>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {group.label}
              </p>
              <div className="flex flex-wrap gap-2">
                {ASPECT_RATIOS.filter((r) => r.orientation === group.orientation).map((r) => {
                  const active = effectiveSelectedId === r.id;
                  const w = r.w >= r.h ? SWATCH_BOX : Math.round(SWATCH_BOX * (r.w / r.h));
                  const h = r.w >= r.h ? Math.round(SWATCH_BOX * (r.h / r.w)) : SWATCH_BOX;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      aria-pressed={active}
                      data-testid={`ratio-card-${r.id}`}
                      onClick={() => {
                        setSelectedId(r.id);
                        setTouched(true);
                      }}
                      className={`flex w-[9.5rem] cursor-pointer flex-col items-center gap-1.5 rounded-lg border p-3 text-center transition-colors ${
                        active
                          ? "border-primary bg-primary/10 ring-1 ring-primary"
                          : "border-border hover:bg-accent"
                      }`}
                    >
                      <span
                        aria-hidden
                        className="flex items-center justify-center"
                        style={{ height: SWATCH_BOX }}
                      >
                        <span
                          className={`block rounded-[3px] border-2 ${
                            active ? "border-primary" : "border-muted-foreground/50"
                          }`}
                          style={{ width: w, height: h }}
                        />
                      </span>
                      <span className="text-sm font-medium text-foreground">{r.id}</span>
                      <span className="text-[11px] leading-tight text-muted-foreground">
                        {r.hint}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-2 border-t border-border pt-3">
          <p data-testid="ratio-dimensions" className="text-sm tabular-nums text-muted-foreground">
            {dims ? `${dims.width} x ${dims.height}` : ""}
          </p>
          {changed && hasContent && (
            <p data-testid="ratio-reflow-note" className="text-xs text-muted-foreground">
              This piece has {plural}. The agent will reposition them to fit the new frame.
            </p>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" className="cursor-pointer" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            data-testid="ratio-confirm"
            className="cursor-pointer"
            disabled={!changed || busy}
            onClick={() => selected && onConfirm(selected)}
          >
            {hasContent ? "Ask the agent to change it" : "Change ratio"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
