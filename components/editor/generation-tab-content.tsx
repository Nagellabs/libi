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
 * timing, cost (estimate now + click-to-fetch actual). The cost-fetch
 * shape is intentionally parallel to the script-analysis cost path
 * (`lib/analysis/script-providers/*`) so when the real fal.ai
 * generation tools land in Phase 4 we can reuse the same fetch
 * pattern instead of writing a second one.
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

      <CostSection fileId={file.id} meta={meta} />

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

/**
 * Cost section with "Fetch actual cost" button.
 *
 * The button POSTs to /api/files/by-id/<fileId>/generation/refresh-cost and
 * retries on `still_pending` up to 3× spaced 10s apart — mirrors the
 * script-analysis cost-refresh pattern (which has its own retry orchestration
 * in `lib/queries/scripts.ts`). The endpoint is single-attempt; cadence lives
 * here in the UI so each network roundtrip stays short.
 */
function CostSection({ fileId, meta }: { fileId: string; meta: AiGenerationMeta }) {
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [attemptLabel, setAttemptLabel] = useState<string | null>(null);

  const estimate = meta.costEstimate;
  const actual = meta.costActual;

  // Show the button as long as we have a job id and no confirmed actual cost.
  // (Test-mode estimate=0 still gets the button so users can flip it to
  // "free, confirmed" after generation.)
  const canFetch = !actual && Boolean(meta.providerJobId);

  const handleFetchActual = async () => {
    setFetching(true);
    setFetchError(null);
    setAttemptLabel(null);
    try {
      const MAX_ATTEMPTS = 3;
      const DELAY_MS = 10_000;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        setAttemptLabel(`attempt ${attempt}/${MAX_ATTEMPTS}`);
        const resp = await fetch(
          `/api/files/by-id/${encodeURIComponent(fileId)}/generation/refresh-cost`,
          { method: "POST", headers: { "Content-Type": "application/json" } },
        );
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          throw new Error(
            `Cost fetch failed (HTTP ${resp.status}): ${text.slice(0, 200)}`,
          );
        }
        const body = (await resp.json()) as {
          status: string;
          hint?: string;
          aiGeneration: AiGenerationMeta | null;
        };
        if (
          body.status === "resolved" ||
          body.status === "free" ||
          body.status === "already_resolved"
        ) {
          setAttemptLabel(null);
          // The endpoint emits refresh_query; the panel re-renders when the
          // file query refetches and we'll see costActual on the next pass.
          return;
        }
        if (body.status === "provider_permission_denied") {
          // Permanent with the current key — retrying is pointless.
          throw new Error(
            body.hint ??
              "The provider's billing API refused the configured API key.",
          );
        }
        if (body.status === "no_provider_fetch_support") {
          throw new Error(`No cost fetcher registered for "${meta.provider}".`);
        }
        if (body.status === "no_request_id") {
          throw new Error(
            "Generation has no provider job id — actual cost cannot be fetched.",
          );
        }
        if (body.status === "no_meta") {
          throw new Error("File has no AI generation metadata.");
        }
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, DELAY_MS));
        }
      }
      setFetchError(
        "Cost not yet available from the provider after 3 attempts. Try again in a minute.",
      );
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
      setAttemptLabel(null);
    }
  };

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
      {canFetch && (
        <div className="pt-1 flex items-center gap-2">
          <button
            type="button"
            onClick={handleFetchActual}
            disabled={fetching}
            className="cursor-pointer text-xs rounded border border-border px-2 py-1 hover:bg-surface-hover disabled:opacity-50"
          >
            {fetching ? "Fetching…" : "Fetch actual cost"}
          </button>
          {attemptLabel && (
            <span className="text-xs text-muted-foreground">{attemptLabel}</span>
          )}
        </div>
      )}
      {fetchError && (
        <div className="text-xs text-destructive">{fetchError}</div>
      )}
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
