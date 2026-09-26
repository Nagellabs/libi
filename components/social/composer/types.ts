import type { SocialPlatform, InstagramPostType } from "@/lib/social/catalog";
import type { SocialFitResponse } from "@/lib/queries/social";
import type { TargetOptions, TikTokCreatorInfo } from "@/lib/social/types";

/** The five steps, in order. The rail renders this array — nothing else
 *  decides step order. */
export const STEPS = ["media", "targets", "caption", "when", "review"] as const;
export type Step = (typeof STEPS)[number];

export const STEP_LABEL: Record<Step, string> = {
  media: "Media",
  targets: "Targets",
  caption: "Caption",
  when: "When",
  review: "Review",
};

/** What the Posting tab hands the composer: one piece, optionally one export
 *  and one Zernio draft that is being edited rather than created. */
export interface ComposerIntent {
  pieceId: string;
  pieceName: string;
  exportPath?: string | null;
  draftPostId?: string | null;
}

/** The piece's most recent export, as the editor already knows it. */
export interface LatestExport {
  filePath: string;
  width: number;
  height: number;
  sizeBytes: number;
  durationSeconds: number;
}

/** One chosen account plus the options that platform requires. Local state —
 *  nothing is persisted until the provider has the post. */
export interface TargetDraft {
  platform: SocialPlatform;
  accountId: string;
  options: TargetOptions;
}

/** `POST /api/social/fit`'s answer, as the query hook types it. */
export type FitResponse = SocialFitResponse;

/**
 * TikTok's two consent boxes. Kept OUT of `TikTokOptions` on purpose: the
 * wire type's `contentPreviewConfirmed` / `expressConsentGiven` are
 * `literal(true)` — they exist only on a post that is actually being sent, so
 * an unchecked box has to live somewhere that can hold `false`.
 */
export interface TikTokConsent {
  preview: boolean;
  express: boolean;
}

export const PLATFORM_LABEL: Record<SocialPlatform, string> = { instagram: "Instagram", tiktok: "TikTok" };

export const IG_TYPE_LABEL: Record<InstagramPostType, string> = { reel: "Reel", feed: "Feed", story: "Story" };

/** The fit check's post type for a target: Instagram's chosen content type,
 *  TikTok's only one. */
export function postTypeOf(t: TargetDraft): string {
  return t.options.platform === "instagram" ? t.options.instagram.contentType : "video";
}

/** A target's human name, matching the fit check's own verdict wording. */
export function targetLabel(platform: SocialPlatform, postType: string): string {
  const type = platform === "instagram" ? IG_TYPE_LABEL[postType as InstagramPostType] ?? postType : postType;
  return `${PLATFORM_LABEL[platform]} ${type}`;
}

export function defaultOptions(
  platform: SocialPlatform,
  defaults: { instagramType: InstagramPostType; aiLabel: boolean },
): TargetOptions {
  if (platform === "instagram") {
    return {
      platform: "instagram",
      instagram: {
        contentType: defaults.instagramType,
        shareToFeed: true,
        commentsEnabled: true,
        isAiGenerated: defaults.aiLabel,
      },
    };
  }
  return {
    platform: "tiktok",
    tiktok: {
      // Placeholders only, so the shape is complete. The privacy level and the
      // three interaction switches are REPLACED by `seedFromCreatorInfo` the
      // moment this account's creator info arrives — neither is libi's to
      // choose. The two consents start FALSE and are only ever true because
      // the user ticked the boxes.
      privacyLevel: "",
      allowComment: false,
      allowDuet: false,
      allowStitch: false,
      commercialContentType: "none",
      madeWithAi: defaults.aiLabel,
      contentPreviewConfirmed: false,
      expressConsentGiven: false,
    },
  };
}

/**
 * The account's own TikTok answer applied to a target's options: a privacy
 * level the platform no longer offers is replaced by the first one it does,
 * and the three interaction switches are turned ON wherever TikTok says this
 * account MAY have them on.
 *
 * On by default, not TikTok's `default`. Comments, duets and stitches are what
 * make a post travel, and TikTok reports `default: false` for all three on
 * this account — which meant every post libi made shipped with engagement
 * switched off unless the user noticed three toggles and flipped them. The one
 * thing that is never overridden is `enabled: false`: that is the account
 * genuinely not being allowed, and forcing it on would have the platform
 * reject the post.
 *
 * `seedInteractions` is false once the user (or a restored draft) has had a
 * say — creator info arriving again must never overwrite a choice.
 */
export function seedFromCreatorInfo(
  o: TargetOptions & { platform: "tiktok" },
  info: TikTokCreatorInfo,
  seedInteractions: boolean,
): TargetOptions & { platform: "tiktok" } {
  const t = o.tiktok;
  const next = {
    ...t,
    ...(seedInteractions
      ? {
          allowComment: info.interactions.allow_comment?.enabled !== false,
          allowDuet: info.interactions.allow_duet?.enabled !== false,
          allowStitch: info.interactions.allow_stitch?.enabled !== false,
        }
      : {}),
    ...(info.privacyLevels.includes(t.privacyLevel) ? {} : { privacyLevel: info.privacyLevels[0] ?? "" }),
  };
  const same =
    next.privacyLevel === t.privacyLevel &&
    next.allowComment === t.allowComment &&
    next.allowDuet === t.allowDuet &&
    next.allowStitch === t.allowStitch;
  // The SAME object back when nothing changed: a fresh one every time is a
  // re-render every time, and this runs from a child's effect.
  return same ? o : { platform: "tiktok", tiktok: next };
}

export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** m:ss, the same rounding the server-side fit check uses. */
export function mmss(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
}

/** Mebibytes (1024²) — the same unit the server-side fit check prints and the
 *  same one the catalog's `maxBytes` limits are written in, so a size shown
 *  here and a limit quoted there are comparable. */
export function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "e.mp4 · 0:34 · 1080×1920 · 41.0 MB" */
export function exportLine(e: LatestExport): string {
  return `${basename(e.filePath)} · ${mmss(e.durationSeconds)} · ${e.width}×${e.height} · ${mb(e.sizeBytes)}`;
}

export function fmtInt(n: number): string {
  // Pinned to en-US: this copy is specified character for character
  // ("0 / 2,200 · fold at 125") and the rest of the UI is English anyway.
  return n.toLocaleString("en-US");
}
