"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useFetchMusicPlan, useMusicPlan, type MusicChoice, type MusicPlanTarget } from "@/lib/queries/social-music";
import { useSetPlatformPick, type UserPlatformPick } from "@/lib/queries/audio-rights";
import { platformLabel, type SocialPlatform } from "@/lib/social/catalog";
import { PLATFORM_MUSIC_RULES, type MusicMode, type TargetMusic } from "@/lib/social/music-policy";
import type { PickTrack } from "@/lib/audio-rights/types";
import { MusicSentence } from "./music-sentence";
import { TrackPicker, type TrackPickerChoice } from "./track-picker";

const modeLabel = (m: MusicMode, P: string): string =>
  m === "attach" ? `Attach ${P}'s licensed track` : m === "draft" ? `Send a ${P} draft to finish in the app` : m === "include" ? "Keep the song in the video" : "Post without the song";

/** The song a post's music is about — the piece's main copyrighted song. */
export interface MainSong {
  fileId: string;
  track?: { title: string; artist?: string };
}

const sameChoice = (a: MusicChoice | null | undefined, b: MusicChoice | null | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * One target's music (addendum §5): the plan sentence, the modes the platform
 * allows, requirement banners and warnings, the shared track picker where the
 * account can attach, and the volumes. The plan comes from the server
 * (`resolveMusicPlan`, the same function `libi.post_piece` uses). A pick here
 * is the song's (one pick per song per platform), so it is NOT kept as a post
 * override: it rides as one only until the write lands, then the song's pick
 * carries it — a later pick from the details panel or a "Find again" wins on
 * the next plan. The post's own override (`choice`) holds only what the user
 * chose for THIS post (include / strip, or attach with no track to write) —
 * never the plan's resolved music, which may be an automatic match.
 */
export function MusicBlock({
  pieceId,
  platform,
  accountId,
  value,
  choice: initialChoice,
  onChoice,
  mainSong,
  mainSongLoading,
  mainSongError,
  onChange,
  onResolved,
  onAwaitingPick,
  onError,
}: {
  pieceId: string;
  platform: SocialPlatform;
  accountId: string;
  /** The music this target last reported — seeds the volumes only, never the plan's override. */
  value?: TargetMusic;
  /** The user's explicit override for this post, kept by the parent across remounts. */
  choice?: MusicChoice;
  /** A user action changed the override. `expected` = apply only if the parent still holds it (a pending pick settling). */
  onChoice?: (next: MusicChoice | undefined, expected?: MusicChoice) => void;
  mainSong?: MainSong;
  /** `usePieceAudioRights` hasn't answered yet: `mainSong` being undefined here
   *  is NOT "no song" — the picker must not let a pick through while the song
   *  it would be attached to is still unknown, or the write silently drops. */
  mainSongLoading?: boolean;
  /** The audio-rights query itself failed (not just loading) — same reason the
   *  picker must not let a pick through, but there's nothing to wait out. */
  mainSongError?: boolean;
  onChange: (music: TargetMusic | undefined) => void;
  /** Rail-mark ONLY: whether the plan is confidently decided (no needsChoice).
   *  A fallback mode is still a decided plan — this never gates Next. */
  onResolved?: (resolved: boolean) => void;
  /** Attach is set but no track is picked yet (`plan.awaitingPick`): nothing is
   *  reported, so Next holds, and the parent names why. */
  onAwaitingPick?: (awaiting: boolean) => void;
  /** The plan REQUEST itself failed. Picks the blocked-reason wording on a
   *  copyrighted piece; blocking itself is driven by `onChange` never having
   *  delivered a value. */
  onError?: (hasError: boolean) => void;
}) {
  const P = platformLabel(platform);
  const rules = PLATFORM_MUSIC_RULES[platform];
  const [choice, setChoiceState] = useState<MusicChoice | null>(() => initialChoice ?? null);
  const choiceRef = useRef(choice);
  const setChoice = (next: MusicChoice | null) => {
    choiceRef.current = next;
    setChoiceState(next);
    onChoice?.(next ?? undefined);
  };
  const [volumes, setVolumes] = useState<{ music: number; original: number } | null>(() =>
    value?.mode === "attach" ? { music: value.musicVolume, original: value.originalVolume } : null,
  );
  /** The track a pick in flight names — shown as picked at once, while its plan loads. */
  const [pendingTrack, setPendingTrack] = useState<PickTrack | null>(null);
  const setPick = useSetPlatformPick();
  const fetchPlan = useFetchMusicPlan();
  const target: MusicPlanTarget = useMemo(() => ({ platform, accountId, ...(choice ? { music: choice } : {}) }), [platform, accountId, choice]);
  const planQ = useMusicPlan(pieceId, target);
  const planned = planQ.data?.targets[0];
  const plan = planned?.plan;

  const awaitingPick = !!plan?.awaitingPick;
  const reported: TargetMusic | undefined = useMemo(() => {
    // Waiting on the user's pick: nothing is decided, so Next holds.
    if (!planned || !planQ.data?.hasMusic || planned.plan.awaitingPick) return undefined;
    const m = planned.music;
    return m.mode === "attach" && volumes ? { ...m, musicVolume: volumes.music, originalVolume: volumes.original } : m;
  }, [planned, planQ.data?.hasMusic, volumes]);
  const reportedKey = JSON.stringify(reported ?? null);
  useEffect(() => {
    onChange(reported);
    // Reported by value: a new object with the same content is not a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportedKey]);
  const resolved = !!plan && !plan.needsChoice && !awaitingPick;
  useEffect(() => {
    if (plan) onResolved?.(resolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, !!plan]);
  useEffect(() => {
    if (plan) onAwaitingPick?.(awaitingPick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingPick, !!plan]);
  useEffect(() => {
    onError?.(planQ.isError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planQ.isError]);

  if (planQ.isLoading) return <Skeleton data-testid="music-block-skeleton" className="h-16 w-full" />;
  if (planQ.isError) {
    return (
      <div data-testid="music-plan-error" className="space-y-1 text-xs text-red-600 dark:text-red-400">
        <p>Couldn&apos;t work out the music plan — try again.</p>
        <button
          type="button"
          data-testid="music-plan-retry"
          onClick={() => void planQ.refetch()}
          className="cursor-pointer underline"
        >
          Try again
        </button>
      </div>
    );
  }
  if (!plan) return null;
  if (!planQ.data?.hasMusic) return <MusicSentence text={plan.sentence} />;
  const vol = volumes ?? (plan.volumes ? { music: plan.volumes.music, original: plan.volumes.original } : null);
  /**
   * The mode the card shows: the user's own choice at once (the plan for it
   * may still be loading), else attach while a pick is awaited (the plan's
   * `mode` is then only an agent's fallback), else the plan's.
   */
  const shownMode: MusicMode =
    choice?.mode && plan.allowedModes.includes(choice.mode) ? choice.mode : awaitingPick ? "attach" : plan.mode;
  const showPicker = plan.allowedModes.includes("attach") && shownMode === "attach";
  const pending = choice?.mode === "attach" && choice.trackId && pendingTrack?.id === choice.trackId ? pendingTrack : null;
  const pickerValue = pending
    ? { status: "picked" as const, track: pending }
    : !awaitingPick && plan.mode === "attach" && plan.track
      ? { status: "picked" as const, track: plan.track }
      : null;
  /**
   * One user action, one write: the song's pick. Until it lands the pick rides
   * as this post's override (so the plan answers at once); then the override
   * is dropped — after the override-free plan is fetched fresh, so the switch
   * never flashes a stale plan — and the song's pick carries it. A failed
   * write (its error is shown) or no song to write to leaves the pick as this
   * post's own choice.
   */
  const writeSongPick = (pending: MusicChoice, songPick: UserPlatformPick | null) => {
    setChoice(pending);
    if (!mainSong) return;
    setPick
      .mutateAsync({ fileId: mainSong.fileId, platform, pick: songPick })
      .then(async () => {
        await fetchPlan(pieceId, { platform, accountId }).catch(() => undefined);
        if (sameChoice(choiceRef.current, pending)) {
          choiceRef.current = null;
          setChoiceState(null);
        }
        onChoice?.(undefined, pending);
      })
      .catch(() => {
        /* shown through `setPick.error`; the pick stays this post's choice */
      });
  };
  const pick = (c: TrackPickerChoice) => {
    if (c.status === "picked") {
      setPendingTrack(c.track);
      writeSongPick({ mode: "attach", trackId: c.track.id }, { status: "picked", track: c.track, accountId });
    } else {
      writeSongPick({ mode: "draft" }, { status: "draft", accountId });
    }
  };
  /**
   * The mode menu (M9). Draft is the song's pick, exactly like "Send as a
   * draft". Attach LEAVING a draft clears the song's draft pick, so its own
   * match decides again — never re-writing a shown track as the user's: it
   * may have been an automatic match, and a user pick survives a rename and
   * blocks rematching. Attach from Keep in / Leave out is this post's own
   * `{mode: "attach"}`: the song's track (a user's included) still decides
   * which track, untouched — but never the MODE. Only dropping the override
   * let a song's draft pick turn the user's Attach straight back into Draft.
   * Keep in / leave out are this post's alone.
   */
  const selectMode = (m: MusicMode) => {
    if (m === "draft" && rules.draftHandoff) return pick({ status: "draft" });
    if (m === "attach") return plan.mode === "draft" && !awaitingPick ? writeSongPick({ mode: "attach" }, null) : setChoice({ mode: "attach" });
    setChoice({ mode: m });
  };

  return (
    <div data-testid="music-block" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">Music</span>
        {plan.allowedModes.length > 1 && (
          <select
            data-testid="music-mode"
            aria-label={`${P} music`}
            value={shownMode}
            onChange={(e) => selectMode(e.target.value as MusicMode)}
            className="cursor-pointer rounded border border-border bg-background px-1.5 py-0.5 text-xs"
          >
            {plan.allowedModes.map((m) => (
              <option key={m} value={m}>
                {modeLabel(m, P)}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className={planQ.isPlaceholderData ? "opacity-60 transition-opacity" : undefined}>
        {awaitingPick && shownMode === "attach" ? (
          <p data-testid="music-awaiting-pick" className="text-xs">
            Pick a track below to attach it — or choose another option above.
          </p>
        ) : (
          <MusicSentence text={plan.sentence} />
        )}
      </div>
      {plan.needs && !awaitingPick && (
        <p data-testid="music-needs" className="rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-600 dark:text-amber-400">
          {plan.needs}
        </p>
      )}
      {plan.warnings.map((w) => (
        <div key={w} data-testid="music-warning" className="text-xs text-amber-600 dark:text-amber-400">
          <MusicSentence text={w} testId="music-warning-text" />
        </div>
      ))}
      {shownMode === "draft" && plan.mode === "draft" && rules.finishLink === "tiktok-inbox" && (
        // The how-to-finish link and QR belong to the post once it's sent (PostMusicSummary), not here.
        <p data-testid="music-finish-after-post" className="text-xs text-muted-foreground">
          Once it&apos;s posted, the post shows how to open the draft in {P}.
        </p>
      )}
      {showPicker &&
        (mainSongError ? (
          <p data-testid="music-track-picker-error" className="text-xs text-red-600 dark:text-red-400">
            Couldn&apos;t load this song&apos;s details — reopen the Posting tab to pick a track.
          </p>
        ) : mainSongLoading ? (
          <Skeleton data-testid="music-track-picker-loading" className="h-16 w-full" />
        ) : (
          <TrackPicker platform={platform} accountId={accountId} value={pickerValue} song={mainSong?.track} onPick={pick} />
        ))}
      {shownMode === "attach" && plan.mode === "attach" && vol && (
        <div data-testid="music-volumes" className="space-y-2 rounded-md border border-border p-3 text-xs">
          <div className="font-medium">Volume</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block cursor-pointer">
              <span className="flex items-center justify-between">
                <span>{P} track</span>
                <span className="w-10 text-right tabular-nums text-muted-foreground">{vol.music}%</span>
              </span>
              <input data-testid="music-volume" type="range" min={0} max={100} value={vol.music} onChange={(e) => setVolumes({ ...vol, music: Number(e.target.value) })} className="mt-1 w-full cursor-pointer" />
            </label>
            <label className="block cursor-pointer">
              <span className="flex items-center justify-between">
                <span>Original sound</span>
                <span className="w-10 text-right tabular-nums text-muted-foreground">{vol.original}%</span>
              </span>
              <input data-testid="original-volume" type="range" min={0} max={100} value={vol.original} onChange={(e) => setVolumes({ ...vol, original: Number(e.target.value) })} className="mt-1 w-full cursor-pointer" />
            </label>
          </div>
        </div>
      )}
      {setPick.error && <p className="text-xs text-red-600 dark:text-red-400">{setPick.error.message}</p>}
    </div>
  );
}
