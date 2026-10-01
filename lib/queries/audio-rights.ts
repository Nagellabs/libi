/** Rights-aware audio queries (spec §4): the timeline's © badges, the export
 *  dialog's copyrighted-music list, and the rights-edit mutation behind the
 *  file details panel's "I own this". */
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fileKeys, useFiles, useGlobalFiles } from "@/lib/queries/files";
import { isCopyrighted } from "@/lib/audio-rights/read";
import type { AudioRightsClass, AudioTrack, PickTrack, PlatformPicks } from "@/lib/audio-rights/types";
import { socialKeys } from "@/lib/queries/social";
import type { KnownPlatform } from "@/lib/social/catalog";
import type { SongMatchResult } from "@/lib/social/music-match";

export const pieceAudioKeys = {
  all: ["piece-audio-rights"] as const,
  forPiece: (pieceId: string) => ["piece-audio-rights", pieceId] as const,
};

export interface PieceAudioRightsResponse {
  copyrighted: Array<{ fileId: string; name: string; fileType: string | null; track?: AudioTrack; clipSeconds: number; platformPicks?: PlatformPicks }>;
  ownMusic: Array<{ fileId: string; name: string; fileType: string | null; class: "generated" | "owned"; track?: AudioTrack }>;
}

/** Copyrighted file ids among the piece's and the library's files — the timeline's © badges. */
export function useCopyrightedFileIds(pieceId: string): Set<string> {
  const piece = useFiles(pieceId);
  const global = useGlobalFiles();
  return useMemo(
    () => new Set([...(piece.data ?? []), ...(global.data ?? [])].filter((f) => isCopyrighted(f)).map((f) => f.id)),
    [piece.data, global.data],
  );
}

/** The export dialog's "Copyrighted audio" list and the posting UI's piece summary. */
export function usePieceAudioRights(pieceId: string | null) {
  return useQuery({
    queryKey: pieceAudioKeys.forPiece(pieceId ?? ""),
    enabled: !!pieceId,
    queryFn: async (): Promise<PieceAudioRightsResponse> => {
      const res = await fetch(`/api/pieces/${pieceId}/audio-rights`);
      if (!res.ok) throw new Error("Failed to read the piece's audio rights");
      return res.json();
    },
  });
}

/** The file details panel's rights edit — "I own this" and the track fields. */
export function useUpdateAudioRights() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ fileId, ...body }: { fileId: string; class?: AudioRightsClass; track?: AudioTrack | null }): Promise<void> => {
      const res = await fetch(`/api/files/by-id/${fileId}/audio-rights`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Couldn't save the audio rights");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: fileKeys.all });
      qc.invalidateQueries({ queryKey: pieceAudioKeys.all });
    },
  });
}

export type UserPlatformPick = { status: "picked"; track: PickTrack; accountId?: string } | { status: "draft"; accountId?: string };

/** The user's track for a song on one platform — the Music step's and the details panel's picker. */
export function useSetPlatformPick() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ fileId, platform, pick }: { fileId: string; platform: KnownPlatform; pick: UserPlatformPick | null }): Promise<void> => {
      const res = await fetch(`/api/files/by-id/${fileId}/platform-picks`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, pick }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Couldn't save the track");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: fileKeys.all });
      qc.invalidateQueries({ queryKey: pieceAudioKeys.all });
      // The music plans read the song's pick.
      qc.invalidateQueries({ queryKey: socialKeys.all });
    },
  });
}

/** The details panel's "Find again": match the song on the platforms now. A user-started wait. */
export function useFindSongAgain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (fileId: string): Promise<SongMatchResult> => {
      const res = await fetch(`/api/files/by-id/${fileId}/music-match`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body as { error?: string }).error ?? "Couldn't match the song");
      return body as SongMatchResult;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: fileKeys.all });
      qc.invalidateQueries({ queryKey: pieceAudioKeys.all });
      qc.invalidateQueries({ queryKey: socialKeys.all });
    },
  });
}
