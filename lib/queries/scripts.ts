"use client";

import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { analysisKeys, useVideoAnalysis } from "@/lib/queries/analysis";
import { useAllJobs } from "@/lib/queries/jobs";
import {
  findLatestScriptStep,
  parseScriptStep,
  toMs,
  type PersistedScript,
} from "@/lib/analysis/scripts";
import type { JobStatusSnapshot } from "@/lib/jobs/types";

export const scriptKeys = {
  // Reserved for future script-specific endpoints. Today both hooks below
  // reuse other queries' caches.
  all: ["scripts"] as const,
};

/** All `script:*` rows for a file, parsed, sorted newest-first. */
export function useScripts(fileId: string | null): {
  data: PersistedScript[] | undefined;
  isLoading: boolean;
  isSuccess: boolean;
} {
  const q = useVideoAnalysis(fileId);
  const data = useMemo<PersistedScript[] | undefined>(() => {
    if (!q.data) return undefined;
    const rows = q.data.steps.filter((s) => s.kind.startsWith("script:"));
    rows.sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt));
    const parsed: PersistedScript[] = [];
    for (const r of rows) {
      const p = parseScriptStep(r);
      if (p) parsed.push(p);
    }
    return parsed;
  }, [q.data]);
  return { data, isLoading: q.isLoading, isSuccess: q.isSuccess };
}

/** The most-recently-created script for this file (or undefined). */
export function useLatestScript(fileId: string | null): {
  data: PersistedScript | undefined;
  isLoading: boolean;
  isSuccess: boolean;
} {
  const q = useVideoAnalysis(fileId);
  const data = useMemo<PersistedScript | undefined>(() => {
    if (!q.data) return undefined;
    const latest = findLatestScriptStep(q.data.steps);
    if (!latest) return undefined;
    return parseScriptStep(latest) ?? undefined;
  }, [q.data]);
  return { data, isLoading: q.isLoading, isSuccess: q.isSuccess };
}

/** The newest `extra_analysis_model` job for this fileId, or undefined.
 *  Polls every 2s when any matching job is in flight (via useAllJobs). */
export function useScriptJob(fileId: string | null): {
  data: JobStatusSnapshot | undefined;
  isLoading: boolean;
  isSuccess: boolean;
} {
  const q = useAllJobs({ kind: "extra_analysis_model" });
  const data = useMemo<JobStatusSnapshot | undefined>(() => {
    if (!q.data || !fileId) return undefined;
    const forFile = q.data.jobs.filter((j) => j.fileId === fileId);
    if (forFile.length === 0) return undefined;
    forFile.sort((a, b) => toMs(b.startedAt) - toMs(a.startedAt));
    return forFile[0];
  }, [q.data, fileId]);
  return { data, isLoading: q.isLoading, isSuccess: q.isSuccess };
}

/** User-initiated refresh of the real billed cost for a script row. fal's
 *  billing endpoint can take hours-to-days to populate, so we don't poll at
 *  generation time — the user clicks the "est" chip to ask now.
 *
 *  Drives up to 3 sequential POSTs to /refresh-cost with a 10s delay between
 *  attempts. Returns as soon as the server reports `resolved` (or after the
 *  3rd attempt either way). Exposes `attempt` so the UI can show progress
 *  ("Checking… (2/3)"). Invalidates the analysis query on each successful
 *  write so the chip updates live. */
export const SCRIPT_REFRESH_COST_MAX_ATTEMPTS = 3;
export const SCRIPT_REFRESH_COST_DELAY_MS = 10_000;

export type ScriptRefreshCostStatus =
  | "resolved"
  | "still_pending"
  | "provider_permission_denied"
  | "no_request_id"
  | "no_provider_fetch_support"
  | "stale"
  | "error";

export interface ScriptRefreshCostOutcome {
  status: ScriptRefreshCostStatus;
  /** Number of attempts that ran (1..MAX_ATTEMPTS). */
  attemptsRun: number;
  /** User-facing explanation for permanent failures (e.g. the fal API key
   *  isn't ADMIN-scoped). Present on `provider_permission_denied`. */
  hint?: string;
}

export function useRefreshScriptCost(
  fileId: string | null,
  kind: string | null,
): {
  refresh: () => Promise<ScriptRefreshCostOutcome | null>;
  isPending: boolean;
  attempt: number;
  lastOutcome: ScriptRefreshCostOutcome | null;
} {
  const qc = useQueryClient();
  const [isPending, setIsPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [lastOutcome, setLastOutcome] = useState<ScriptRefreshCostOutcome | null>(null);

  const refresh = useCallback(async (): Promise<ScriptRefreshCostOutcome | null> => {
    if (!fileId || !kind || isPending) return null;
    setIsPending(true);
    setLastOutcome(null);
    let outcome: ScriptRefreshCostOutcome = { status: "still_pending", attemptsRun: 0 };
    try {
      for (let i = 0; i < SCRIPT_REFRESH_COST_MAX_ATTEMPTS; i += 1) {
        setAttempt(i + 1);
        let json: { status?: string; hint?: string } | null = null;
        try {
          const res = await fetch(
            `/api/files/by-id/${encodeURIComponent(fileId)}/analysis/refresh-cost`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ kind }),
            },
          );
          json = (await res.json().catch(() => null)) as {
            status?: string;
            hint?: string;
          } | null;
          if (!res.ok) {
            outcome = { status: "error", attemptsRun: i + 1 };
            break;
          }
        } catch {
          outcome = { status: "error", attemptsRun: i + 1 };
          break;
        }

        const status = (json?.status ?? "error") as ScriptRefreshCostStatus;
        outcome = { status, attemptsRun: i + 1, hint: json?.hint };

        // Terminal states — don't retry. `provider_permission_denied` is
        // permanent with the current key; hammering the API can't fix it.
        if (
          status === "resolved" ||
          status === "provider_permission_denied" ||
          status === "no_request_id" ||
          status === "no_provider_fetch_support" ||
          status === "stale"
        ) {
          break;
        }

        // still_pending or error → maybe retry. Don't sleep after the final.
        if (i < SCRIPT_REFRESH_COST_MAX_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, SCRIPT_REFRESH_COST_DELAY_MS));
        }
      }

      // Invalidate so the chip re-renders with the new server state regardless
      // of outcome (server updated costLastCheckedAt on every successful call).
      qc.invalidateQueries({ queryKey: analysisKeys.byFile(fileId) });

      setLastOutcome(outcome);
      return outcome;
    } finally {
      setIsPending(false);
      setAttempt(0);
    }
  }, [fileId, kind, isPending, qc]);

  return { refresh, isPending, attempt, lastOutcome };
}
