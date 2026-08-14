"use client";

import { useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { pieceKeys } from "./pieces";
import { folderKeys } from "./folders";
import { useAllJobs, jobKeys } from "./jobs";

export function useDuplicatePiece() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      pieceId: string;
      name?: string;
      source?: "draft" | "snapshot";
      folderId?: string | null;
    }) => {
      const res = await fetch(`/api/pieces/${input.pieceId}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error("Failed to duplicate piece");
      return res.json() as Promise<{ pieceId: string; name: string; jobId: string }>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pieceKeys.all });
      qc.invalidateQueries({ queryKey: folderKeys.all });
      // Refetch the jobs list so `useDuplicatingPieceIds` immediately picks up
      // the new piece_dup job and renders the copy-in-progress spinner. Without
      // this the jobs query stays idle (its poll only runs while a job is
      // already in-flight) and the spinner never appears.
      qc.invalidateQueries({ queryKey: jobKeys.all });
    },
  });
}

export function useDuplicateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      folderId: string;
      name?: string;
      source?: "draft" | "snapshot";
    }) => {
      const res = await fetch(`/api/folders/${input.folderId}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error("Failed to duplicate folder");
      return res.json() as Promise<{
        folderId: string;
        name: string;
        jobIds: string[];
        pieceCount: number;
      }>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pieceKeys.all });
      qc.invalidateQueries({ queryKey: folderKeys.all });
      // Refetch the jobs list so the per-piece copy spinners appear immediately.
      qc.invalidateQueries({ queryKey: jobKeys.all });
    },
  });
}

/**
 * Set of piece ids with an active (queued/running) `piece_dup` job — drives
 * the copy-in-progress spinner in the resources panel. Derived from the
 * shared `useAllJobs()` jobs list (`lib/queries/jobs.ts`), which already
 * polls every 2s while any job is in flight, so the set clears on its own
 * when a duplication completes. SSE `refresh_query` for `pieces` also fires
 * on completion.
 */
export function useDuplicatingPieceIds(): Set<string> {
  const { data } = useAllJobs({ kind: "piece_dup" });
  const jobs = data?.jobs;
  return useMemo(
    () =>
      new Set(
        (jobs ?? [])
          .filter(
            (j) =>
              j.kind === "piece_dup" &&
              (j.status === "queued" ||
                j.status === "running" ||
                j.status === "cancel-requested"),
          )
          .map((j) => j.pieceId)
          .filter((id): id is string => !!id),
      ),
    [jobs],
  );
}
