"use client";

import { useState } from "react";
import { Pause, Play } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BusyLabel } from "@/components/agents-page/agents-tab/steps/busy-label";
import { TrackPicker, type TrackPickerChoice } from "@/components/social/music/track-picker";
import { usePreviewPlayer } from "@/components/social/music/use-preview-player";
import { useSocialAccounts, useSocialStatus } from "@/lib/queries/social";
import { useMusicCatalog, useSocialMusicFacts } from "@/lib/queries/social-music";
import { useFindSongAgain, useSetPlatformPick } from "@/lib/queries/audio-rights";
import { isComposablePlatform, platformLabel, type SocialPlatform } from "@/lib/social/catalog";
import { PLATFORM_MUSIC_RULES, accountPerPlatform, catalogQueryFor, songSocialRow } from "@/lib/social/music-policy";
import { musicPreviewSrc, previewHostAllowed } from "@/lib/social/music-preview";
import type { AudioRights, PickTrack } from "@/lib/audio-rights/types";
import type { PlatformMatch } from "@/lib/social/music-match";

type PreviewPlayer = ReturnType<typeof usePreviewPlayer>;

/** A platform Find again could not finish — a row can't show that, its pick is unchanged. */
function errorLine(platform: SocialPlatform, reason: Extract<PlatformMatch, { status: "error" }>["reason"]): string {
  const P = platformLabel(platform);
  if (reason === "timeout") return `${P} didn't answer in time — try Find again.`;
  if (reason === "song_changed") return `The song changed while ${P} was looking — try Find again.`;
  return `${P}'s music library couldn't be read — try Find again.`;
}

/** ▶ for a picked track: its preview from the platform's catalog, when the
 *  catalog still lists it. Takes the block's ONE shared player, so playing a
 *  second row's preview stops whatever the first was playing. */
function RowPreview({
  platform,
  accountId,
  track,
  song,
  player,
}: {
  platform: SocialPlatform;
  accountId: string;
  track: PickTrack;
  song?: { title: string; artist?: string };
  player: PreviewPlayer;
}) {
  const catalog = useMusicCatalog(platform, accountId, catalogQueryFor(platform, song));
  const hit = catalog.data && "tracks" in catalog.data ? catalog.data.tracks.find((t) => t.id === track.id) : undefined;
  if (!hit?.previewUrl || !previewHostAllowed(hit.previewUrl)) return null;
  const on = player.currentId === hit.id && player.playing;
  return (
    <button
      type="button"
      data-testid={`song-social-play-${platform}`}
      aria-label={on ? `Pause ${track.title}` : `Play ${track.title}`}
      onClick={() => player.toggle(hit.id, musicPreviewSrc(hit.previewUrl!))}
      className="cursor-pointer text-muted-foreground hover:text-foreground"
    >
      {on ? <Pause className="size-3" /> : <Play className="size-3" />}
    </button>
  );
}

/** The details panel's "On social" block (addendum §6): one row per connected
 *  platform that can attach, each with the song's pick; Choose/Change opens the
 *  shared picker; "Find again" re-runs matching. */
export function SongOnSocial({ fileId, rights }: { fileId: string; rights: AudioRights }) {
  const status = useSocialStatus();
  const connected = !!status.data?.connected && rights.class === "copyrighted";
  const accounts = useSocialAccounts(connected);
  const facts = useSocialMusicFacts(connected);
  const setPick = useSetPlatformPick();
  const findAgain = useFindSongAgain();
  const player = usePreviewPlayer();
  const { audioRef, audioProps } = player;
  const [open, setOpen] = useState<{ platform: SocialPlatform; accountId: string } | null>(null);
  if (!connected) return null;
  if (accounts.isLoading || facts.isLoading) {
    return (
      <div className="space-y-1" data-testid="song-on-social-skeleton">
        <Skeleton className="h-3 w-48" />
        <Skeleton className="h-3 w-40" />
      </div>
    );
  }
  const targets = accountPerPlatform(accounts.data ?? [], facts.data?.facts ?? {}).filter(
    (t) => PLATFORM_MUSIC_RULES[t.platform].catalog !== "none" && isComposablePlatform(t.platform),
  );
  if (targets.length === 0) return null;
  const choose = (c: TrackPickerChoice) => {
    if (!open) return;
    setPick.mutate({
      fileId,
      platform: open.platform,
      pick: c.status === "picked" ? { status: "picked", track: c.track, accountId: open.accountId } : { status: "draft", accountId: open.accountId },
    });
    setOpen(null);
  };
  const openPick = open ? rights.platformPicks?.[open.platform] : undefined;
  // Only THIS file's result: the panel may since have moved to another file.
  const findResult = findAgain.variables === fileId ? findAgain.data : undefined;
  // Every row already reads its own outcome from the refreshed platformPicks;
  // these lines are only for what a row can't show — matching was skipped
  // entirely, it found nothing to attach on any platform, or a platform
  // didn't finish (its row still shows the old pick).
  const nothingMatched = !!findResult && ("skipped" in findResult ? true : Object.keys(findResult.platforms).length === 0);
  const errorLines =
    findResult && !nothingMatched && "platforms" in findResult
      ? (Object.entries(findResult.platforms) as Array<[SocialPlatform, PlatformMatch]>).flatMap(([p, m]) => (m.status === "error" ? [errorLine(p, m.reason)] : []))
      : [];

  return (
    <div className="space-y-1" data-testid="song-on-social">
      <div className="text-[11px] font-medium">On social</div>
      {targets.map((t) => {
        const row = songSocialRow(t.platform, t.facts, rights.platformPicks?.[t.platform]);
        const platform = t.platform as SocialPlatform;
        return (
          <div key={t.platform} data-testid={`song-social-row-${t.platform}`} className="flex items-center gap-2 text-[11px]">
            <span className="min-w-0 flex-1 truncate">{row.text}</span>
            {row.track && <RowPreview platform={platform} accountId={t.accountId} track={row.track} song={rights.track} player={player} />}
            {row.action && (
              <button
                type="button"
                data-testid={`song-social-action-${t.platform}`}
                onClick={() => setOpen({ platform, accountId: t.accountId })}
                className="cursor-pointer text-primary hover:underline"
              >
                {row.action === "change" ? "Change" : "Choose"}
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        data-testid="song-find-again"
        onClick={() => findAgain.mutate(fileId)}
        aria-disabled={findAgain.isPending || undefined}
        className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-primary hover:underline aria-disabled:pointer-events-none aria-disabled:opacity-80"
      >
        {findAgain.isPending ? <BusyLabel>Finding again…</BusyLabel> : "Find again"}
      </button>
      {(nothingMatched || errorLines.length > 0) && (
        <div data-testid="song-find-again-summary" className="text-[11px] text-muted-foreground">
          {(nothingMatched ? findResult!.summary : errorLines).map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      )}
      {(setPick.error || findAgain.error) && <p className="text-[11px] text-red-500">{(setPick.error ?? findAgain.error)!.message}</p>}
      <audio ref={audioRef} hidden {...audioProps} />
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="sm:max-w-xl" data-testid="song-picker-dialog">
          <DialogHeader>
            <DialogTitle>{open ? `Pick the ${platformLabel(open.platform)} track` : ""}</DialogTitle>
          </DialogHeader>
          {open && (
            <TrackPicker
              platform={open.platform}
              accountId={open.accountId}
              value={openPick ? { status: openPick.status, ...(openPick.track ? { track: openPick.track } : {}) } : null}
              song={rights.track}
              onPick={choose}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
