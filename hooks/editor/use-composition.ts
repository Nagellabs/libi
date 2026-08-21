"use client";

import { useMemo } from "react";
import type { Composition, Overlay, AudioClip } from "@/lib/engine/types";
import { usePieceComposition } from "@/lib/queries/pieces";
import { useQuery } from "@tanstack/react-query";
import { useFiles, useGlobalFiles } from "@/lib/queries/files";
import {
  buildComposition,
} from "@/lib/composition/build-composition";
import { useEditorState } from "@/lib/editor-state-context";
import type { CompositionManifest } from "@/lib/composition/persistence";
import { getCompositionFrames } from "@/lib/engine/renderer";

export interface UseCompositionResult {
  /** Hydrated composition (overlay array attached), or null when empty/loading. */
  composition: Composition | null;
  /** Total frame count — the end of the latest overlay or audio clip. Zero when composition is null. */
  totalFrames: number;
  /** True while the composition query is loading (matches the pre-extraction behavior). */
  isLoading: boolean;
  /** True while the composition query is re-fetching (for auto-show seek timing). */
  isFetching: boolean;
  /**
   * The raw persisted manifest for the active view (draft or snapshot).
   * Threaded through for callers that need manifest-level data
   * (`CompositionManifest`, not the runtime `Composition`). Null when no
   * piece is open.
   */
  manifest: CompositionManifest | null;
}

/**
 * Editor's composition derivation layer. Owns:
 *   - `usePieceComposition` query
 *   - `useFiles` query + filesById index (for proxy URL selection)
 *   - `overlays` / `composition` / `totalFrames` memos
 *
 * Returns null-safe values so the editor page can render skeletons +
 * empty states without guarding at every call site.
 */
export function useComposition(activePieceId: string | null): UseCompositionResult {
  const enabled = !!activePieceId;
  const { viewMode } = useEditorState();
  const isSnapshotMode = viewMode === "snapshot";

  // Draft mode: standard composition query.
  const compositionQuery = usePieceComposition(activePieceId ?? "", {
    enabled: enabled && !isSnapshotMode,
  });

  // Snapshot mode: fetch the committed snapshot manifest from a separate
  // endpoint so the two views never collide in the React Query cache.
  const snapshotQuery = useQuery({
    queryKey: ["composition-snapshot", activePieceId] as const,
    queryFn: async () => {
      const res = await fetch(`/api/pieces/${activePieceId}/snapshot/source`);
      if (!res.ok) {
        return {
          manifest: { width: 1920, height: 1080, fps: 30 } as CompositionManifest,
          audioClips: [] as AudioClip[],
        };
      }
      // The snapshot/source endpoint returns a raw CompositionManifest.
      // Reshape it to match the usePieceComposition response shape so the
      // rest of this hook can treat both branches identically.
      const manifest = (await res.json()) as CompositionManifest;
      return {
        manifest,
        audioClips: (manifest.audioClips ?? []) as AudioClip[],
      };
    },
    enabled: enabled && isSnapshotMode,
  });

  // Unify the two branches so the rest of the hook is mode-agnostic.
  const activeQuery = isSnapshotMode ? snapshotQuery : compositionQuery;

  // useFiles already gates internally on `!!pieceId`, so passing `""` when
  // inactive is inert. We only include filesQuery here for the filesById
  // index that drives proxy URL selection inside buildComposition.
  const filesQuery = useFiles(activePieceId ?? "");
  // Global files load app-wide (cached); needed so a video overlay backed by a
  // GLOBAL file isn't mistaken for a deleted one in missing-file detection.
  const globalFilesQuery = useGlobalFiles();


  const filesById = useMemo(
    () => new Map((filesQuery.data ?? []).map((f) => [f.id, f] as const)),
    [filesQuery.data],
  );

  // Every file id known to exist (piece ∪ global) + whether both queries have
  // settled. buildComposition flags a video scene `missing` only when the id
  // is in neither set AND the lists have loaded — never mid-flight.
  const knownFileIds = useMemo(
    () =>
      new Set<string>([
        ...(filesQuery.data ?? []).map((f) => f.id),
        ...(globalFilesQuery.data ?? []).map((f) => f.id),
      ]),
    [filesQuery.data, globalFilesQuery.data],
  );
  const filesResolved = filesQuery.isSuccess && globalFilesQuery.isSuccess;

  const overlays = useMemo<Overlay[]>(
    () => (activeQuery.data?.manifest.overlays ?? []) as Overlay[],
    [activeQuery.data?.manifest.overlays],
  );

  const audioClips = useMemo(
    () => (activeQuery.data?.audioClips ?? []) as AudioClip[],
    [activeQuery.data?.audioClips],
  );

  const manifestWidth = activeQuery.data?.manifest.width;
  const manifestHeight = activeQuery.data?.manifest.height;
  const manifestFps = activeQuery.data?.manifest.fps;

  const composition = useMemo(
    () => {
      if (!activePieceId) return null;
      const base = buildComposition(filesById, overlays, audioClips, {
        knownFileIds,
        filesResolved,
      });
      // `buildComposition` hardcodes 1920×1080/30 — honor the piece's actual
      // composition dimensions (set via libi.update_composition_dimensions) so
      // the preview canvas sizes correctly and tracked-overlay coordinates,
      // which are in source-video pixel space, line up with the letterboxed
      // base frame.
      return {
        ...base,
        width: manifestWidth ?? base.width,
        height: manifestHeight ?? base.height,
        fps: manifestFps ?? base.fps,
      };
    },
    [
      activePieceId,
      filesById,
      knownFileIds,
      filesResolved,
      overlays,
      audioClips,
      manifestWidth,
      manifestHeight,
      manifestFps,
    ],
  );

  const totalFrames = useMemo(
    () => (composition ? getCompositionFrames(composition) : 0),
    [composition],
  );

  return {
    composition,
    totalFrames,
    // Matches the pre-extraction behavior: only the composition query gates
    // the skeleton. Files load in parallel and populate URLs progressively.
    isLoading: enabled && activeQuery.isLoading,
    isFetching: activeQuery.isFetching,
    manifest: activeQuery.data?.manifest ?? null,
  };
}
