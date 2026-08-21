/** Snapshot / Draft MCP tool implementations */

import { commitDraft, discardDraft, restoreSnapshot, getPieceState, compareStates } from "@/lib/composition/lifecycle";
import { loadManifest, EMPTY_MANIFEST } from "@/lib/composition/persistence";
import { loadCurrentSnapshot } from "@/lib/composition/snapshots";
import { findUnvalidatedGeneratedClips, type UnvalidatedClip } from "@/lib/composition/generated-asset-gate";
import type {
  GetPieceStateParams,
  CommitDraftParams,
  DiscardDraftParams,
  RestoreSnapshotParams,
  CompareStatesParams,
} from "./schemas";

export interface ToolResultSuccess<T> { success: true; data: T }
export interface ToolResultFailure { success: false; error: string; data?: unknown }
export type ToolResult<T> = ToolResultSuccess<T> | ToolResultFailure;

export async function getPieceStateTool(params: GetPieceStateParams): Promise<ToolResult<{
  pieceId: string;
  hasDraft: boolean;
  snapshotSummary: string | null;
  snapshotCommittedAt: number | null;
  recentSnapshots: { id: string; committedAt: number; summary: string; actor: string }[];
}>> {
  try {
    const state = await getPieceState(params.pieceId);
    return { success: true, data: state };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function commitDraftTool(params: CommitDraftParams): Promise<ToolResult<{
  snapshotId: string;
  summary: string;
  committedAt: number;
}> | (ToolResultFailure & { data: { unvalidatedClips: UnvalidatedClip[]; hint: string } })> {
  try {
    // Verify-gate: refuse to commit when AI-generated video clips on the
    // timeline have no completed analysis — UNLESS the caller explicitly
    // acknowledges (user accepted committing un-validated clips). This gate is
    // un-fakeable: it requires real analysis_steps / analysis_keyframes rows,
    // which only exist after the agent actually runs the analysis tools.
    if (params.acknowledgeUnvalidated !== true) {
      const unvalidatedClips = await findUnvalidatedGeneratedClips(params.pieceId);
      if (unvalidatedClips.length > 0) {
        return {
          success: false,
          error: "unvalidated_generated_clips",
          data: {
            unvalidatedClips,
            hint:
              "These AI-generated clips on the timeline have no completed analysis. For EACH (analysis is keyed by fileId — there is no analysis_start/finalize call): libi.analysis_extract_frames({ fileId, count: 4 }) → vision-Read every frame's absolutePath → libi.analysis_save_frames({ fileId, frames }) → libi.analysis_save_summary({ fileId, summary }) (this is Stage 4.5 in the ugc-product-video skill). After validating, re-call commit_draft. If the user explicitly wants to commit without validation, pass acknowledgeUnvalidated: true.",
          },
        };
      }
    }
    const summary = params.summary ?? "Agent edits";
    const result = await commitDraft(params.pieceId, { summary, actor: "agent" });
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function discardDraftTool(params: DiscardDraftParams): Promise<ToolResult<{ pieceId: string }>> {
  if (params.confirm !== true) {
    return { success: false, error: "Must set confirm: true to discard draft" };
  }
  try {
    await discardDraft(params.pieceId);
    return { success: true, data: { pieceId: params.pieceId } };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function restoreSnapshotTool(params: RestoreSnapshotParams): Promise<ToolResult<{
  pieceId: string;
  snapshotId: string;
}>> {
  if (params.confirm !== true) {
    return { success: false, error: "Must set confirm: true to restore snapshot" };
  }
  try {
    await restoreSnapshot(params.pieceId, params.snapshotId);
    return { success: true, data: { pieceId: params.pieceId, snapshotId: params.snapshotId } };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function compareStatesTool(params: CompareStatesParams): Promise<ToolResult<{
  hasDraft: boolean;
  overlays: { added: number; removed: number; changed: number };
  audioClips: { added: number; removed: number; changed: number };
  totalChanges: number;
}>> {
  try {
    const snapshot = await loadCurrentSnapshot(params.pieceId);
    const draft = await loadManifest(params.pieceId);
    const diff = compareStates(snapshot ?? EMPTY_MANIFEST, draft);
    const state = await getPieceState(params.pieceId);
    return { success: true, data: { hasDraft: state.hasDraft, ...diff } };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
