"use client";

import { useState } from "react";
import type { AudioClip } from "@/lib/engine/types";
import { DEFAULT_DUCK } from "@/lib/audio/duck-params";

interface DuckConfigDialogProps {
  clip: AudioClip;
  candidates: AudioClip[]; // possible sidechain clips (not the clip itself)
  /** Echo back EVERY field so submit doesn't silently overwrite agent-set
   *  attackMs / releaseMs back to defaults. */
  onApply: (params: {
    sidechainClipId: string;
    thresholdDb: number;
    ratio: number;
    reductionDb: number;
    attackMs: number;
    releaseMs: number;
  }) => void;
  onCancel: () => void;
}

export default function DuckConfigDialog({ clip, candidates, onApply, onCancel }: DuckConfigDialogProps) {
  // Seed every field from the existing duck so PATCH preserves user
  // (or agent) tuning. The dialog only exposes 3 sliders, but attackMs /
  // releaseMs round-trip via initial-state echo on submit.
  const initial = clip.duck ?? DEFAULT_DUCK;
  const [sidechainClipId, setSidechain] = useState(initial.sidechainClipId || candidates[0]?.id || "");
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
          Make this clip dip in volume when the chosen sidechain clip plays loudly.
        </p>

        <label className="mb-3 block text-xs">
          <span className="mb-1 block text-muted-foreground">Sidechain (the loud one)</span>
          <select
            value={sidechainClipId}
            onChange={(e) => setSidechain(e.target.value)}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
          >
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label ?? `${c.kind} clip ${c.id.slice(0, 6)}`}
              </option>
            ))}
          </select>
        </label>

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
            onClick={() => onApply({ sidechainClipId, thresholdDb, ratio, reductionDb, attackMs, releaseMs })}
            disabled={!sidechainClipId}
            className="cursor-pointer rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/80 disabled:opacity-40"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
