/**
 * A piece's music plan per target (spec §6.1, §6.4): piece audio + the
 * account's facts + (when attach is on the table) the platform's catalog →
 * `resolveMusicPlan`. Server-only. The composer, the Posting tab and
 * `libi.post_piece` / `libi.social_music_search` all ask this one service.
 */
import { loadManifest } from "@/lib/composition/persistence";
import { manifestAsExported } from "@/lib/overlays/hidden";
import { filesForManifest } from "@/lib/audio-rights/piece-reader";
import { pieceAudioOf } from "@/lib/audio-rights/piece-audio";
import { resolveExportAudio, type AudioDecision } from "@/lib/export/audio-policy";
import { getSocialSettings } from "@/lib/db/settings";
import { withAdapter } from "./service";
import { isComposablePlatform, type KnownPlatform } from "./catalog";
import { resolveAccountFacts } from "./music-facts";
import {
  PLATFORM_MUSIC_RULES,
  planToTargetMusic,
  resolveMusicPlan,
  canAttachOn,
  catalogQueryFor,
  copyrightedDefaultFor,
  type AccountMusicFacts,
  type CatalogTrack,
  type ExportVariant,
  type MusicMode,
  type MusicPlan,
  type TargetMusic,
} from "./music-policy";
import { serverLogger as logger } from "@/lib/logger";

export interface PlanRequestTarget {
  platform: KnownPlatform;
  accountId?: string;
  music?: { mode?: MusicMode; trackId?: string; soundName?: string };
}

export interface PlannedTarget {
  platform: KnownPlatform;
  accountId?: string;
  plan: MusicPlan;
  music: TargetMusic;
}

export interface PiecePlan {
  copyrighted: boolean;
  hasMusic: boolean;
  targets: PlannedTarget[];
  /** The audio decision each export variant carries — what an export for that variant must match. */
  variants: Record<ExportVariant, AudioDecision>;
}

export async function planPieceMusic(pieceId: string, targets: PlanRequestTarget[]): Promise<PiecePlan> {
  // What the export will play: a song only on a hidden layer is not planned.
  const manifest = manifestAsExported(await loadManifest(pieceId));
  const files = filesForManifest(manifest);
  const audio = pieceAudioOf(manifest, files);
  const variants: Record<ExportVariant, AudioDecision> = {
    "without-song": resolveExportAudio(manifest, files, { purpose: "social" }).decision,
    "with-song": resolveExportAudio(manifest, files, { purpose: "social", copyrightedAudio: "include" }).decision,
  };
  const providerId = getSocialSettings().providerId;
  const main = audio.copyrighted[0]?.rights.track;
  const out: PlannedTarget[] = [];

  for (const t of targets) {
    let facts: AccountMusicFacts = {};
    // Absent = the catalog was not asked; null = it could not be read.
    let catalog: CatalogTrack[] | null | undefined;
    let picked: CatalogTrack | undefined;
    if (providerId && t.accountId && isComposablePlatform(t.platform) && audio.copyrighted.length > 0) {
      const accountId = t.accountId;
      const platform = t.platform;
      facts = await withAdapter((a) => resolveAccountFacts(a, providerId, { id: accountId, platform }));
      const pick = audio.copyrighted[0]?.rights.platformPicks?.[platform];
      const wantsAttach = canAttachOn(platform, facts) && (t.music?.mode ?? copyrightedDefaultFor(platform, facts, pick)) === "attach";
      // A stored track is the plan's track: no catalog read unless the post
      // names a different one — except on a trending list, which changes
      // daily: it is always read (one call, no query) so a pick that left it
      // is told apart from one still offered.
      const hasStoredTrack = pick?.status === "picked" && !t.music?.trackId && PLATFORM_MUSIC_RULES[platform].catalog !== "trending";
      if (wantsAttach && !hasStoredTrack) {
        const query = catalogQueryFor(platform, main);
        const r = await withAdapter((a) => a.musicCatalog(accountId, { platform, ...(query ? { query } : {}) }));
        catalog = "tracks" in r ? r.tracks : null;
        const trackId = t.music?.trackId;
        if (trackId) {
          picked = catalog?.find((c) => c.id === trackId);
          // A pick from an earlier search need not be in THIS search's results.
          if (!picked && PLATFORM_MUSIC_RULES[platform].catalog === "search") {
            picked = (await withAdapter((a) => a.getCatalogTrack?.(accountId, trackId) ?? Promise.resolve(null))) ?? undefined;
          }
        }
      }
    }
    const plan = resolveMusicPlan(
      { platform: t.platform, ...(catalog !== undefined ? { catalog } : {}) },
      facts,
      audio,
      {
        ...(t.music?.mode ? { mode: t.music.mode } : {}),
        ...(picked ? { track: picked } : {}),
        ...(t.music?.soundName ? { soundName: t.music.soundName } : {}),
      },
    );
    logger.info(
      { tag: "social-music", op: "plan_resolved", pieceId, platform: t.platform, mode: plan.mode, needsChoice: !!plan.needsChoice },
      "music plan resolved",
    );
    out.push({ platform: t.platform, ...(t.accountId ? { accountId: t.accountId } : {}), plan, music: planToTargetMusic(plan) });
  }
  return {
    copyrighted: audio.copyrighted.length > 0,
    hasMusic: audio.copyrighted.length + audio.ownMusic.length > 0,
    targets: out,
    variants,
  };
}
