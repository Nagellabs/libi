"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Formats seconds as m:ss — 229 -> "3:49", 3 -> "0:03". */
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const secs = s % 60;
  return `${m}:${secs.toString().padStart(2, "0")}`;
}

/**
 * A piece has no stored length — it ends where its last clip ends. Dropping
 * a track that runs past that point would otherwise silently stretch the
 * piece with no signal at all, so this asks: extend the piece, trim the
 * clip, or pick a length in between. An asset that already fits never shows
 * this (see preview-surface.tsx#onDropAudio) — the dialog only exists for
 * the over-length case.
 *
 * Mirrors components/preview/aspect-ratio-dialog.tsx for structure/styling.
 */
export function AudioLengthDialog({
  open,
  assetName,
  assetDurationSec,
  pieceDurationSec,
  startTimeSec = 0,
  onChoose,
  onCancel,
}: {
  open: boolean;
  assetName: string;
  assetDurationSec: number;
  pieceDurationSec: number;
  /** Where the clip will start. "Trim to fit" is the room LEFT from here to the
   *  piece's end, not the piece's whole length — a clip dropped at 0.16s with
   *  duration == pieceDurationSec still ends past the piece and stretches it,
   *  which is exactly what this dialog exists to prevent. Mirrors the server
   *  gate, which trims to `pieceEnd - startTime`. */
  startTimeSec?: number;
  onChoose: (durationSec: number) => void;
  onCancel: () => void;
}) {
  const [showSpecific, setShowSpecific] = useState(false);
  const trimDurationSec = Math.max(0, pieceDurationSec - startTimeSec);
  const [specificValue, setSpecificValue] = useState(String(trimDurationSec));

  const confirmSpecific = () => {
    const parsed = Number(specificValue);
    const clamped = Number.isFinite(parsed)
      ? Math.min(Math.max(parsed, 0.01), assetDurationSec)
      : assetDurationSec;
    onChoose(clamped);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>This track runs past the piece</DialogTitle>
          <DialogDescription>
            &quot;{assetName}&quot; is {formatDuration(assetDurationSec)} but this piece is{" "}
            {formatDuration(pieceDurationSec)}.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Button
            variant="outline"
            className="w-full cursor-pointer justify-start"
            onClick={() => onChoose(assetDurationSec)}
          >
            Extend the piece to match
          </Button>
          <Button
            variant="outline"
            className="w-full cursor-pointer justify-start"
            onClick={() => onChoose(trimDurationSec)}
          >
            Trim the clip to fit
          </Button>
          <Button
            variant="outline"
            className="w-full cursor-pointer justify-start"
            aria-pressed={showSpecific}
            onClick={() => setShowSpecific(true)}
          >
            Specific length…
          </Button>
          {showSpecific && (
            <div className="flex items-center gap-2 pl-2">
              <Input
                type="number"
                min={1}
                max={assetDurationSec}
                value={specificValue}
                onChange={(e) => setSpecificValue(e.target.value)}
                className="w-24"
                aria-label="Length in seconds"
                autoFocus
              />
              <span className="text-xs text-muted-foreground">seconds</span>
              <Button size="sm" className="cursor-pointer" onClick={confirmSpecific}>
                Add
              </Button>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" className="cursor-pointer" onClick={onCancel}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
