/**
 * Where the user finishes by hand (D10). TikTok has NO documented deep link to
 * its inbox or drafts (researched 2026-09-27: only video/profile/sound/hashtag
 * deep links exist), so the TikTok link is the app itself — a universal link
 * that opens TikTok on a phone — plus a QR code and one instruction.
 */
import type { SocialTarget } from "./types";
import type { TargetMusic } from "./music-policy";

export const TIKTOK_APP_URL = "https://www.tiktok.com/";
export const TIKTOK_FINISH_INSTRUCTION = "On your phone, open TikTok and tap the inbox notification for this draft.";

export type FinishLink =
  | { kind: "tiktok-inbox"; label: "Open TikTok to finish"; href: string; qr: string; instruction: string }
  | { kind: "youtube-studio-editor"; label: "Open in YouTube Studio"; href: string }
  | { kind: "instagram-app"; label: "Replace the audio in the Instagram app"; href: string };

export const TIKTOK_FINISH_LINK: FinishLink = {
  kind: "tiktok-inbox",
  label: "Open TikTok to finish",
  href: TIKTOK_APP_URL,
  qr: TIKTOK_APP_URL,
  instruction: TIKTOK_FINISH_INSTRUCTION,
};

export function youtubeStudioEditorUrl(videoId: string): string {
  return `https://studio.youtube.com/video/${encodeURIComponent(videoId)}/editor`;
}

export function finishLinkFor(target: SocialTarget, music: TargetMusic | undefined, pieceHasCopyrighted: boolean): FinishLink | null {
  if (target.status !== "published") return null;
  // A draft handoff libi decided, or an inbox upload the provider reports (whoever sent it).
  if (target.platform === "tiktok" && (music?.mode === "draft" || target.delivery === "inbox")) {
    return TIKTOK_FINISH_LINK;
  }
  if (target.platform === "youtube" && target.platformPostId && pieceHasCopyrighted) {
    return { kind: "youtube-studio-editor", label: "Open in YouTube Studio", href: youtubeStudioEditorUrl(target.platformPostId) };
  }
  if (target.platform === "instagram" && target.url && (music?.mode === "include" || (!music && pieceHasCopyrighted))) {
    return { kind: "instagram-app", label: "Replace the audio in the Instagram app", href: target.url };
  }
  return null;
}
