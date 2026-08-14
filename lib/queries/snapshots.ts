import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { pieceKeys } from "./pieces";
import type { SnapshotHistoryEntry } from "@/lib/composition/snapshots";

// ── Query keys ──────────────────────────────────────────────────────

export const snapshotKeys = {
  all: ["snapshots"] as const,
  state: (pieceId: string) => [...snapshotKeys.all, "state", pieceId] as const,
  compare: (pieceId: string) => [...snapshotKeys.all, "compare", pieceId] as const,
  history: (pieceId: string) => [...snapshotKeys.all, "history", pieceId] as const,
  versionDiff: (pieceId: string, versionId: string) =>
    [...snapshotKeys.all, "version-diff", pieceId, versionId] as const,
};

// ── Response types ───────────────────────────────────────────────────

export interface PieceStateResponse {
  pieceId: string;
  hasDraft: boolean;
  snapshotSummary: string | null;
  snapshotCommittedAt: number | null;
  recentSnapshots: SnapshotHistoryEntry[];
}

export interface SceneRef {
  id: string;
  name: string;
}

export interface CompareStatesResponse {
  hasDraft: boolean;
  scenes: { added: SceneRef[]; removed: SceneRef[]; changed: SceneRef[] };
  overlays: { added: number; removed: number; changed: number };
  audioClips: { added: number; removed: number; changed: number };
  totalChanges: number;
}

// ── Version history types ────────────────────────────────────────────

export type VersionKind = "draft" | "snapshot" | "history";

export interface VersionRow {
  id: string;
  kind: VersionKind;
  summary: string | null;
  committedAt: number | null;
  actor: "agent" | "user";
  changeCount: number;
  missingFileCount: number;
}

export interface SceneRefDTO {
  id: string;
  name: string;
  type: "canvas" | "video";
  duration: number;
  fileId: string | null;
}

export interface ChangedSceneRefDTO extends SceneRefDTO {
  reasons: string[];
}

export interface EntityRefDTO {
  id: string;
  kind: string;
  label: string;
}

export interface StripTileDTO extends SceneRefDTO {
  changeKind: "added" | "removed" | "changed" | "unchanged";
}

export interface FileRefDTO {
  fileId: string;
  refKind: "scene" | "overlay" | "audio";
  refName: string;
}

export interface EnrichedDiffDTO {
  scenes: { added: SceneRefDTO[]; removed: SceneRefDTO[]; changed: ChangedSceneRefDTO[] };
  overlays: { added: EntityRefDTO[]; removed: EntityRefDTO[]; changed: EntityRefDTO[] };
  audioClips: { added: EntityRefDTO[]; removed: EntityRefDTO[]; changed: EntityRefDTO[] };
  sceneStrip: StripTileDTO[];
  totalChanges: number;
}

export interface VersionDiffResponse {
  id: string;
  kind: VersionKind;
  summary: string | null;
  committedAt: number | null;
  actor: "agent" | "user";
  diff: EnrichedDiffDTO;
  restoreImpact: EnrichedDiffDTO | null;
  missingFiles: FileRefDTO[];
}

// ── Queries ─────────────────────────────────────────────────────────

export function usePieceState(pieceId: string) {
  return useQuery({
    queryKey: snapshotKeys.state(pieceId),
    queryFn: async (): Promise<PieceStateResponse> => {
      const res = await fetch(`/api/pieces/${pieceId}/snapshot/state`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: !!pieceId,
  });
}

export function useCompareStates(pieceId: string, enabled = true) {
  return useQuery({
    queryKey: snapshotKeys.compare(pieceId),
    queryFn: async (): Promise<CompareStatesResponse> => {
      const res = await fetch(`/api/pieces/${pieceId}/snapshot/compare`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: enabled && !!pieceId,
  });
}

export function useVersionHistory(pieceId: string, enabled = true) {
  return useQuery({
    queryKey: snapshotKeys.history(pieceId),
    queryFn: async (): Promise<{ versions: VersionRow[] }> => {
      const res = await fetch(`/api/pieces/${pieceId}/snapshot/history`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: enabled && !!pieceId,
  });
}

export function useVersionDiff(pieceId: string, versionId: string | null, enabled = true) {
  return useQuery({
    queryKey: snapshotKeys.versionDiff(pieceId, versionId ?? ""),
    queryFn: async (): Promise<VersionDiffResponse> => {
      const res = await fetch(`/api/pieces/${pieceId}/snapshot/history/${versionId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: enabled && !!pieceId && !!versionId,
  });
}

// ── Mutations ───────────────────────────────────────────────────────

export function useCommitDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ pieceId, summary }: { pieceId: string; summary?: string }) => {
      const res = await fetch(`/api/pieces/${pieceId}/snapshot/commit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: (_data, { pieceId }) => {
      void qc.invalidateQueries({ queryKey: snapshotKeys.state(pieceId) });
      void qc.invalidateQueries({ queryKey: snapshotKeys.compare(pieceId) });
      void qc.invalidateQueries({ queryKey: snapshotKeys.history(pieceId) });
      void qc.invalidateQueries({ queryKey: pieceKeys.composition(pieceId) });
    },
  });
}

export function useDiscardDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ pieceId }: { pieceId: string }) => {
      const res = await fetch(`/api/pieces/${pieceId}/snapshot/discard`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: (_data, { pieceId }) => {
      void qc.invalidateQueries({ queryKey: snapshotKeys.state(pieceId) });
      void qc.invalidateQueries({ queryKey: snapshotKeys.compare(pieceId) });
      void qc.invalidateQueries({ queryKey: snapshotKeys.history(pieceId) });
      void qc.invalidateQueries({ queryKey: pieceKeys.composition(pieceId) });
    },
  });
}

export function useRestoreSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ pieceId, snapshotId }: { pieceId: string; snapshotId: string }) => {
      const res = await fetch(`/api/pieces/${pieceId}/snapshot/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshotId, confirm: true }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: (_data, { pieceId }) => {
      void qc.invalidateQueries({ queryKey: snapshotKeys.state(pieceId) });
      void qc.invalidateQueries({ queryKey: snapshotKeys.compare(pieceId) });
      void qc.invalidateQueries({ queryKey: snapshotKeys.history(pieceId) });
      void qc.invalidateQueries({ queryKey: pieceKeys.composition(pieceId) });
    },
  });
}
