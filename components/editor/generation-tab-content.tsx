"use client";

import { useMemo, useState } from "react";
import type { FileRecord } from "@/lib/db/schema/types";
import {
  parseAiGenerationMeta,
  type AiGenerationMeta,
} from "@/lib/ai-generation/types";

interface Props {
  file: FileRecord;
}

/**
 * "Generation" tab body. Rendered only when `file.aiGeneration` is set
 * (the trigger is conditional too in asset-preview-panel.tsx).
 *
 * Shows the recipe for an AI-generated file: provider, model, prompt,
 * timing, and cost. Cost is display-only: libi holds no provider key, so
 * it cannot query a provider's billing API — the estimate comes from the
 * tool that generated the file, and an actual cost only appears when a
 * tool wrote it into `aiGeneration.costActual`.
 */
export function GenerationTabContent({ file }: Props) {
  const meta = useMemo<AiGenerationMeta | null>(
    () => parseAiGenerationMeta(file.aiGeneration),
    [file.aiGeneration],
  );

  if (!meta) {
    return (
      <div className="px-4 py-3 text-xs text-muted-foreground">
        No generation metadata recorded for this file. (Possibly created before
        the Generation provenance column landed, or this is a manual upload.)
      </div>
    );
  }

  return (
    <div className="px-4 py-3 space-y-4 text-[13px]">
      <KeyValueGrid
        rows={[
          ["Provider", meta.provider],
          ["Model", meta.model],
          ["Created", formatIso(meta.completedAt)],
          ["Generation duration", formatDurationMs(meta.durationMs)],
          ["Attempt", meta.attemptNumber === undefined ? "—" : `#${meta.attemptNumber}`],
          ["Provider job id", meta.providerJobId ?? "—"],
        ]}
      />

      <CostSection meta={meta} />

      <PromptSection prompt={meta.prompt} />

      <RawJsonSection meta={meta} />
    </div>
  );
}

function KeyValueGrid({ rows }: { rows: [string, string][] }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1.5">
      {rows.map(([k, v]) => (
        <KeyValueRow key={k} k={k} v={v} />
      ))}
    </div>
  );
}

function KeyValueRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <div className="text-muted-foreground">{k}</div>
      <div className="text-foreground break-all">{v}</div>
    </>
  );
}

/** Cost section — estimate (from the generating tool) and actual (when a
 *  tool has written one). Read-only. */
function CostSection({ meta }: { meta: AiGenerationMeta }) {
  const estimate = meta.costEstimate;
  const actual = meta.costActual;

  return (
    <div className="rounded border border-border p-3 space-y-2">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        Cost
      </div>
      <KeyValueGrid
        rows={[
          ["Estimate", estimate ? formatCost(estimate.amount, estimate.currency, estimate.tier) : "—"],
          ["Actual", actual ? `${formatCost(actual.amount, actual.currency, actual.tier)} (${actual.source})` : "—"],
        ]}
      />
    </div>
  );
}

function PromptSection({ prompt }: { prompt: string }) {
  const [expanded, setExpanded] = useState(prompt.length < 400);
  return (
    <div className="rounded border border-border p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Prompt
        </div>
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          className="cursor-pointer text-xs text-muted-foreground hover:text-foreground"
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      </div>
      <pre
        className={
          "whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed " +
          (expanded ? "" : "max-h-24 overflow-hidden")
        }
      >
        {prompt}
      </pre>
      <button
        type="button"
        onClick={() => navigator.clipboard?.writeText(prompt).catch(() => {})}
        className="cursor-pointer text-xs text-muted-foreground hover:text-foreground"
      >
        Copy prompt
      </button>
    </div>
  );
}

function RawJsonSection({ meta }: { meta: AiGenerationMeta }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        className="cursor-pointer text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? "Hide raw JSON ▾" : "Show raw JSON ▸"}
      </button>
      {open && (
        <pre className="mt-2 rounded border border-border p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap break-all overflow-auto max-h-64">
          {JSON.stringify(meta, null, 2)}
        </pre>
      )}
    </div>
  );
}

function formatIso(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatCost(amount: number, currency: string, tier?: string): string {
  if (amount === 0) return tier === "test-mode" || tier === "test-mode-i2v" ? "Free (test mode)" : `0 ${currency}`;
  const fixed = amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2);
  const cur = currency === "USD" ? "$" : `${currency} `;
  return `${cur}${fixed}${tier ? ` · ${tier}` : ""}`;
}
