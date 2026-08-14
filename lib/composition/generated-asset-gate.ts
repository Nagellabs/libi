/**
 * Verify-gate: AI-generated clips on a timeline must have a real, completed
 * base analysis before the draft can be committed by the agent.
 *
 * Background: during UGC QA the agent SKIPPED the Stage 4.5 validation gate
 * (frame extraction + vision-read + summary) on a physically-broken clip AND
 * fabricated a piece note claiming it had passed. Skill text alone can't stop
 * that — the agent can ignore or lie about it. This module turns the gate into
 * an un-fakeable check: it requires actual `analysis_steps` / `analysis_keyframes`
 * rows to exist for each AI-generated video clip on the timeline. Those rows
 * only come into being when the agent genuinely runs the analysis tools.
 *
 * Enforced in the MCP `commit_draft` tool (agent-only). The UI commit path
 * (REST → `commitDraft` lib fn) is intentionally NOT gated — a human clicking
 * "commit" is a deliberate act; the silent-auto-commit-without-validation case
 * is the one we defend against.
 */
import { inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { loadManifest } from "./persistence";
import type { CompositionManifest } from "./persistence";
import { getAnalysis } from "@/lib/analysis/manager";

export interface UnvalidatedClip {
  fileId: string;
  filename: string;
  reason: string;
}

/**
 * fileIds of video clips the timeline actually plays: video overlays,
 * including a tracked overlay whose content is a video. (Scenes are canvas-only
 * and reference no file.) Image assets are not gated — the failure class we
 * defend against is broken-physics motion in generated *video*.
 */
export function collectTimelineVideoFileIds(manifest: CompositionManifest): string[] {
  const ids = new Set<string>();
  for (const o of manifest.overlays ?? []) {
    if (o.kind === "video" && o.fileId) ids.add(o.fileId);
    if (o.kind === "tracked") {
      const c = o.content;
      if (c && c.kind === "video" && c.fileId) ids.add(c.fileId);
    }
  }
  return [...ids];
}

/**
 * A file counts as AI-generated when it carries provenance: either the
 * structured `ai_generation` column, or a notes lineage line (`… | model=…`).
 * The notes signal is the fallback for the historical window where the
 * `aiGeneration` object got dropped by the stringified-arg bug.
 */
export function isAiGeneratedFile(row: { aiGeneration: string | null; notes: string | null }): boolean {
  if (row.aiGeneration && row.aiGeneration.trim() !== "") return true;
  if (row.notes && /(^|\n)[^\n]*\|\s*model=/.test(row.notes)) return true;
  return false;
}

/**
 * Minimum bar for "this clip was actually analyzed": a `summary` step that
 * reached `ready` AND at least one described (non-skipped) keyframe. Both rows
 * are written only by the real analysis tools, so this can't be faked with a
 * note.
 */
export function hasBaseAnalysis(bundle: {
  steps: { kind: string; status: string }[];
  keyframes: { skipped: boolean; description: string | null }[];
}): boolean {
  const summaryReady = bundle.steps.some((s) => s.kind === "summary" && s.status === "ready");
  const describedFrames = bundle.keyframes.filter((k) => !k.skipped && !!k.description).length;
  return summaryReady && describedFrames >= 1;
}

/**
 * Return the AI-generated video clips on the piece's DRAFT timeline that lack a
 * completed base analysis. Empty array = safe to commit.
 */
export async function findUnvalidatedGeneratedClips(pieceId: string): Promise<UnvalidatedClip[]> {
  const manifest = await loadManifest(pieceId);
  const fileIds = collectTimelineVideoFileIds(manifest);
  if (fileIds.length === 0) return [];

  const db = getDb();
  const rows = db.select().from(files).where(inArray(files.id, fileIds)).all();

  const out: UnvalidatedClip[] = [];
  for (const row of rows) {
    if (!isAiGeneratedFile(row)) continue;
    const bundle = await getAnalysis({ fileId: row.id });
    if (!hasBaseAnalysis(bundle)) {
      out.push({
        fileId: row.id,
        filename: row.filename,
        reason:
          "AI-generated clip on the timeline has no completed analysis (need a ready summary + at least one described keyframe).",
      });
    }
  }
  return out;
}
