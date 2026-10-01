import type { SocialAdapter } from "./adapter";
import type { CreatePostInput } from "./types";
import { platformLabel, type KnownPlatform } from "./catalog";
import { PLATFORM_MUSIC_RULES } from "./music-policy";

export interface GoneTrack {
  platform: KnownPlatform;
  title: string;
}

/**
 * A scheduled post's attached track that its platform no longer offers
 * (spec §6.5; I2), or null. How a track is looked up is the platform RULES'
 * call, never the provider's: a `search` catalog is asked for the track by id;
 * a `trending` list (it changes daily) is read once per account, no query,
 * and the track must be on it. A catalog that can't be read proves nothing —
 * that target is not refused.
 */
export async function goneCatalogTrack(adapter: SocialAdapter, targets: CreatePostInput["targets"]): Promise<GoneTrack | null> {
  const trendingIds = new Map<string, Set<string> | null>();
  for (const t of targets) {
    const music = t.options?.music;
    if (music?.mode !== "attach") continue;
    const platform = t.options.platform;
    const rules = PLATFORM_MUSIC_RULES[platform];
    if (rules.catalog === "search") {
      if (!adapter.getCatalogTrack) continue;
      const found = await adapter.getCatalogTrack(t.accountId, music.track.id);
      if (!found) return { platform, title: music.track.title };
    } else if (rules.catalog === "trending") {
      let ids = trendingIds.get(t.accountId);
      if (ids === undefined) {
        try {
          const r = await adapter.musicCatalog(t.accountId, { platform });
          ids = "tracks" in r ? new Set(r.tracks.map((c) => c.id)) : null;
        } catch {
          ids = null;
        }
        trendingIds.set(t.accountId, ids);
      }
      if (ids && !ids.has(music.track.id)) return { platform, title: music.track.title };
    }
  }
  return null;
}

/** What the refusal says, in the platform's own terms (its rules). */
export function goneTrackMessage(gone: GoneTrack): string {
  const P = platformLabel(gone.platform);
  const rules = PLATFORM_MUSIC_RULES[gone.platform];
  if (rules.catalog === "trending") {
    return `*${gone.title}* is ${rules.pickGoneNote ?? `no longer offered by ${P}`}. Pick another track${rules.draftHandoff ? `, or send the post as a ${P} draft` : " or post without it"}.`;
  }
  return `${P} no longer offers *${gone.title}*. Pick another track or post without it.`;
}
