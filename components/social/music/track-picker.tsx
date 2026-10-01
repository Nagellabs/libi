"use client";

import { useEffect, useState } from "react";
import { Pause, Play } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useMusicCatalog } from "@/lib/queries/social-music";
import { musicArtworkSrc, musicPreviewSrc, previewHostAllowed } from "@/lib/social/music-preview";
import { platformLabel, type SocialPlatform } from "@/lib/social/catalog";
import { PLATFORM_MUSIC_RULES, catalogQueryFor, type CatalogTrack, type MusicUnavailableReason } from "@/lib/social/music-policy";
import type { PickTrack, PlatformPick } from "@/lib/audio-rights/types";
import { mmss } from "@/components/social/composer/types";
import { unavailableLine } from "./unavailable-line";
import { usePreviewPlayer } from "./use-preview-player";

export const SEARCH_DEBOUNCE_MS = 300;
export type TrackPickerChoice = { status: "picked"; track: PickTrack } | { status: "draft" };

const toPickTrack = (t: CatalogTrack): PickTrack => ({
  id: t.id,
  title: t.title,
  ...(t.artist ? { artist: t.artist } : {}),
  ...(t.durationSec !== undefined ? { durationSec: t.durationSec } : {}),
});
const playable = (t?: { previewUrl?: string }): t is { previewUrl: string } => !!t?.previewUrl && previewHostAllowed(t.previewUrl);
const artwork = (t?: { artworkUrl?: string }) => (t?.artworkUrl && previewHostAllowed(t.artworkUrl) ? musicArtworkSrc(t.artworkUrl) : null);

/** What the player bar shows while something plays — kept independent of
 *  whatever list the track came from, since a search's results can change
 *  (or the catalog can still be loading) while the preview keeps playing. */
type PlayingMeta = { id: string; title: string; artist?: string };

/**
 * THE track picker (addendum §4) — the Posting tab's Music step and the
 * details panel's dialog both use it. What differs per platform (search or a
 * trending list, a draft handoff, the note above the list) is read from the
 * platform's music rules.
 */
export function TrackPicker({
  platform,
  accountId,
  value,
  onPick,
  song,
  allowDraft,
}: {
  platform: SocialPlatform;
  accountId: string;
  value: Pick<PlatformPick, "status" | "track"> | null;
  onPick: (choice: TrackPickerChoice) => void;
  song?: { title: string; artist?: string };
  allowDraft?: boolean;
}) {
  const P = platformLabel(platform);
  const rules = PLATFORM_MUSIC_RULES[platform];
  const draftAllowed = allowDraft ?? rules.draftHandoff;
  const searchable = rules.catalog === "search";
  const [q, setQ] = useState(() => catalogQueryFor(platform, song) ?? "");
  const [searched, setSearched] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setSearched(q.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);
  const catalog = useMusicCatalog(platform, accountId, searchable && searched ? searched : undefined);
  const player = usePreviewPlayer();
  const { audioRef, audioProps } = player;
  // The bar's title/artist for whatever is CURRENTLY loaded — set only when a
  // play is started, so it survives the track leaving `tracks` (a changed
  // search) instead of going blank while the audio keeps playing.
  const [playingMeta, setPlayingMeta] = useState<PlayingMeta | null>(null);

  const tracks = catalog.data && "tracks" in catalog.data ? catalog.data.tracks : [];
  const unavailable: MusicUnavailableReason | null = catalog.isError
    ? "error"
    : catalog.data && "unavailable" in catalog.data
      ? catalog.data.unavailable.reason
      : null;
  const pickedId = value?.status === "picked" ? value.track?.id : undefined;
  const fromCatalog = pickedId ? tracks.find((t) => t.id === pickedId) : undefined;
  const selected = fromCatalog ?? (value?.status === "picked" ? value.track : undefined);

  const playTrack = (t: CatalogTrack) => {
    if (!playable(t)) return;
    player.toggle(t.id, musicPreviewSrc(t.previewUrl));
    setPlayingMeta({ id: t.id, title: t.title, ...(t.artist ? { artist: t.artist } : {}) });
  };

  return (
    <div data-testid="track-picker" className="flex min-w-0 flex-col gap-2 text-xs">
      {/* Selected card */}
      <div data-testid="track-picker-selected" className="flex items-center gap-2 rounded-md border border-border p-2">
        {selected ? (
          <>
            {artwork(fromCatalog) ? (
              // A proxied platform thumbnail — nothing for next/image to optimise.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={artwork(fromCatalog)!} alt="" className="size-10 rounded object-cover" />
            ) : (
              <div className="size-10 rounded bg-muted" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{selected.title}</div>
              <div className="truncate text-muted-foreground">
                {selected.artist ?? ""}
                {selected.durationSec !== undefined ? ` · ${mmss(selected.durationSec)}` : ""}
              </div>
            </div>
            {playable(fromCatalog) && (
              <button
                type="button"
                aria-label={player.currentId === fromCatalog!.id && player.playing ? `Pause ${selected.title}` : `Play ${selected.title}`}
                onClick={() => playTrack(fromCatalog!)}
                className="cursor-pointer text-muted-foreground hover:text-foreground"
              >
                {player.currentId === fromCatalog!.id && player.playing ? <Pause className="size-4" /> : <Play className="size-4" />}
              </button>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">{value?.status === "draft" ? `Finishing in the ${P} app` : "No track picked"}</span>
        )}
      </div>

      {rules.pickerNote && (
        <p data-testid="track-picker-note" className="text-muted-foreground">
          {rules.pickerNote}
        </p>
      )}
      {draftAllowed && (
        <button
          type="button"
          data-testid="track-picker-draft"
          onClick={() => onPick({ status: "draft" })}
          className={`cursor-pointer self-start rounded px-2 py-1 ${value?.status === "draft" ? "bg-primary text-primary-foreground" : "border border-border"}`}
        >
          {`Send as a ${P} draft`}
        </button>
      )}
      {searchable && (
        <Input data-testid="track-picker-search" placeholder={`Search ${P}'s music`} value={q} onChange={(e) => setQ(e.target.value)} className="h-7 text-xs" />
      )}

      {unavailable ? (
        <p data-testid="track-picker-unavailable" className="text-muted-foreground">
          {unavailableLine(unavailable, P)}
        </p>
      ) : catalog.isLoading ? (
        <div className="space-y-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-2">
              <Skeleton className="size-8 rounded" />
              <Skeleton className="h-3 flex-1" />
              <Skeleton className="h-5 w-10" />
            </div>
          ))}
        </div>
      ) : (
        <ul data-testid="track-picker-list" className="max-h-64 space-y-1 overflow-y-auto">
          {tracks.map((t) => {
            const loaded = player.currentId === t.id;
            const isPicked = pickedId === t.id;
            return (
              <li key={t.id} data-testid={`track-row-${t.id}`} className="flex items-center gap-2">
                {artwork(t) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={artwork(t)!} alt="" className="size-8 rounded object-cover" />
                ) : (
                  <div className="size-8 rounded bg-muted" />
                )}
                {t.rank !== undefined && <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">#{t.rank}</span>}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{t.title}</span>
                  <span className="block truncate text-muted-foreground">
                    {t.artist ?? ""}
                    {t.durationSec !== undefined ? ` · ${mmss(t.durationSec)}` : ""}
                  </span>
                </span>
                {playable(t) ? (
                  <button
                    type="button"
                    data-testid={`track-play-${t.id}`}
                    aria-pressed={loaded}
                    aria-label={loaded && player.playing ? `Pause ${t.title}` : `Play ${t.title}`}
                    onClick={() => playTrack(t)}
                    className="cursor-pointer text-muted-foreground hover:text-foreground"
                  >
                    {loaded && player.playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                  </button>
                ) : (
                  <span className="size-3.5" />
                )}
                <button
                  type="button"
                  data-testid={`track-use-${t.id}`}
                  onClick={() => onPick({ status: "picked", track: toPickTrack(t) })}
                  // One fixed width for Use and Picked: the row never shifts when a pick lands.
                  className={`w-14 shrink-0 cursor-pointer rounded border py-0.5 text-center ${isPicked ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
                >
                  {isPicked ? "Picked" : "Use"}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Always drawn, idle until something plays: a bar that appeared on the
          first play pushed everything under the picker down. */}
      {!unavailable && (
        <div data-testid="track-picker-player" className="sticky bottom-0 flex items-center gap-2 border-t border-border bg-background pt-2">
          <button
            type="button"
            aria-label={player.playing ? "Pause preview" : "Play preview"}
            disabled={!player.currentId}
            // Resumes/pauses whatever is ALREADY loaded — never re-looked-up in
            // `tracks`, so a search that changes underneath doesn't strand this.
            onClick={() => player.currentId && player.toggle(player.currentId, player.currentSrc!)}
            className="cursor-pointer disabled:cursor-default disabled:opacity-40"
          >
            {player.playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          </button>
          <span className={`min-w-0 flex-1 truncate ${player.currentId ? "" : "text-muted-foreground"}`}>
            {player.currentId ? (playingMeta?.title ?? "") : "Press play on a track to preview it"}
          </span>
          <input
            type="range"
            data-testid="track-picker-seek"
            aria-label="Seek the preview"
            disabled={!player.currentId}
            min={0}
            max={player.duration || 0}
            step={0.1}
            value={player.time}
            onChange={(e) => player.seek(Number(e.target.value))}
            className="w-24 cursor-pointer disabled:cursor-default disabled:opacity-40"
          />
          <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
            {mmss(player.time)} / {mmss(player.duration)}
          </span>
          <input
            type="range"
            data-testid="track-picker-volume"
            aria-label="Preview volume"
            min={0}
            max={100}
            value={Math.round(player.volume * 100)}
            onChange={(e) => player.setVolume(Number(e.target.value) / 100)}
            className="w-16 cursor-pointer"
          />
        </div>
      )}
      <audio ref={audioRef} hidden {...audioProps} />
    </div>
  );
}
