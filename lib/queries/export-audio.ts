/** The export dialog's track list: every track the export plays, its rights, and — for a copyrighted song — what each connected platform does with it. */
import { useMemo } from "react";
import { usePieceAudioRights } from "@/lib/queries/audio-rights";
import { useSocialAccounts, useSocialStatus } from "@/lib/queries/social";
import { useSocialMusicFacts } from "@/lib/queries/social-music";
import { accountPerPlatform, songPlatformsLine } from "@/lib/social/music-policy";
import { songLabel } from "@/lib/audio-rights/types";
import type { ExportAudioTrack } from "@/components/export/audio-defaults";

export interface UseExportAudioTracksResult {
  tracks: ExportAudioTrack[];
  /** True while the piece's audio rights are still loading — an empty
   *  `tracks` here means "not known yet", never "no audio". */
  isLoading: boolean;
  /** True when the piece's audio rights failed to load. */
  isError: boolean;
  refetch: () => void;
}

export function useExportAudioTracks(pieceId: string | null): UseExportAudioTracksResult {
  const audio = usePieceAudioRights(pieceId);
  const status = useSocialStatus();
  const social = !!status.data?.connected && (audio.data?.copyrighted.length ?? 0) > 0;
  const accounts = useSocialAccounts(social);
  const facts = useSocialMusicFacts(social);
  const tracks = useMemo(() => {
    if (!audio.data) return [];
    const platforms = social ? accountPerPlatform(accounts.data ?? [], facts.data?.facts ?? {}) : [];
    return [
      ...audio.data.copyrighted.map((s) => ({
        fileId: s.fileId,
        label: s.track ? songLabel(s.track) : s.name,
        fileType: s.fileType,
        rights: "copyrighted" as const,
        ...(platforms.length > 0 ? { platformsLine: songPlatformsLine(platforms, s.platformPicks) } : {}),
      })),
      ...audio.data.ownMusic.map((s) => ({ fileId: s.fileId, label: s.track ? songLabel(s.track) : s.name, fileType: s.fileType, rights: s.class })),
    ];
  }, [audio.data, social, accounts.data, facts.data]);
  // `audio` (the piece's own rights) is the essential read: the export
  // dialog must not show "no audio" — and a Personal export must not drop a
  // song — while it's still loading or failed. The social queries (platform
  // lines) are a non-blocking enhancement layered on top once `audio` has
  // resolved, so their own loading/error never gates the dialog. A failed
  // background REFETCH with the rights already in hand is not an error here:
  // the tracks it read are still right, and Export must stay enabled.
  return { tracks, isLoading: audio.isLoading, isError: audio.isError && !audio.data, refetch: () => void audio.refetch() };
}
