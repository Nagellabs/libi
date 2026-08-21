"use client";

import { useState } from "react";
import type { AudioClip } from "@/lib/engine/types";
import { DEFAULT_DUCK, duckSidechainIds } from "@/lib/audio/duck-params";

interface DuckConfigDialogProps {
  clip: AudioClip;
  candidates: AudioClip[]; // possible sidechain clips (not the clip itself)
  /** Echo back EVERY field so submit doesn't silently overwrite agent-set
   *  attackMs / releaseMs back to defaults. */
  onApply: (params: {
    sidechainClipIds: string[];
    thresholdDb: number;
    ratio: number;
    reductionDb: number;
    attackMs: number;
    releaseMs: number;
  }) => void;
  onCancel: () => void;
}

const clipLabel = (c: AudioClip) => c.label ?? `${c.kind} clip ${c.id.slice(0, 6)}`;

export default function DuckConfigDialog({ clip, candidates, onApply, onCancel }: DuckConfigDialogProps) {
  // Seed every field from the existing duck so PATCH preserves user
  // (or agent) tuning. The dialog only exposes 3 sliders, but attackMs /
  // releaseMs round-trip via initial-state echo on submit.
  const initial = clip.duck ?? DEFAULT_DUCK;
  // A duck takes ANY number of sidechains — their levels are summed, so a
  // piece with six VO lines ducks under all six. Seed from the existing set,
  // falling back to the first candidate for a brand-new duck.
  const [sidechainClipIds, setSidechains] = useState<string[]>(() => {
    const existing = duckSidechainIds(initial);
    return existing.length > 0 ? existing : candidates.slice(0, 1).map((c) => c.id);
  });
  const toggleSidechain = (id: string) =>
    setSidechains((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const [thresholdDb, setThreshold] = useState(initial.thresholdDb);
  const [ratio, setRatio] = useState(initial.ratio);
  const [reductionDb, setReduction] = useState(initial.reductionDb);
  // NOT exposed in the UI but echoed on submit so they don't get clobbered.
  const attackMs = initial.attackMs;
  const releaseMs = initial.releaseMs;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div className="w-80 rounded-lg border border-border bg-surface p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-3 text-sm font-semibold">Apply Ducking</h3>
        <p className="mb-4 text-xs text-muted-foreground">
          Make this clip dip in volume when any of the chosen sidechain clips plays loudly.
        </p>

        <div className="mb-3 text-xs">
          <span className="mb-1 block text-muted-foreground">
            Sidechains (the loud ones) — pick every voice clip
          </span>
          <div className="max-h-32 overflow-y-auto rounded border border-border bg-background">
            {candidates.length === 0 && (
              <p className="px-2 py-1.5 text-muted-foreground">No other audio clips on the timeline.</p>
            )}
            {candidates.map((c) => (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-2 px-2 py-1.5 hover:bg-surface-hover"
              >
                <input
                  type="checkbox"
                  checked={sidechainClipIds.includes(c.id)}
                  onChange={() => toggleSidechain(c.id)}
                  className="cursor-pointer accent-primary"
                />
                <span className="truncate">{clipLabel(c)}</span>
              </label>
            ))}
          </div>
        </div>

        <label className="mb-3 block text-xs">
          <span className="mb-1 flex justify-between text-muted-foreground">
            <span>Threshold</span><span>{thresholdDb} dB</span>
          </span>
          <input type="range" min={-60} max={0} step={1} value={thresholdDb}
                 onChange={(e) => setThreshold(Number(e.target.value))}
                 className="w-full accent-primary" />
        </label>

        <label className="mb-3 block text-xs">
          <span className="mb-1 flex justify-between text-muted-foreground">
            <span>Ratio</span><span>{ratio}:1</span>
          </span>
          <input type="range" min={1} max={20} step={0.5} value={ratio}
                 onChange={(e) => setRatio(Number(e.target.value))}
                 className="w-full accent-primary" />
        </label>

        <label className="mb-4 block text-xs">
          <span className="mb-1 flex justify-between text-muted-foreground">
            <span>Max reduction</span><span>{reductionDb} dB</span>
          </span>
          <input type="range" min={-30} max={0} step={1} value={reductionDb}
                 onChange={(e) => setReduction(Number(e.target.value))}
                 className="w-full accent-primary" />
        </label>

        {/* Display-only line so the user knows attack/release exist and
            were preserved across the dialog. Editable via MCP only. */}
        <p className="mb-4 text-[10px] text-muted-foreground">
          Attack: {attackMs} ms · Release: {releaseMs} ms (set via agent)
        </p>

        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="cursor-pointer rounded border border-border px-3 py-1 text-xs hover:bg-surface-hover">
            Cancel
          </button>
          <button
            onClick={() => onApply({ sidechainClipIds, thresholdDb, ratio, reductionDb, attackMs, releaseMs })}
            disabled={sidechainClipIds.length === 0}
            className="cursor-pointer rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/80 disabled:opacity-40"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
