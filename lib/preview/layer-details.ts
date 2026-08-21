/**
 * Pure resolvers for the inspector's read-only source panels: what file a
 * selected audio clip or image overlay came from, and what the preview is
 * actually decoding versus the source.
 *
 * Honest about both the proxy substitution (pickVideoUrl serves the proxy when
 * ready) and the previewQuality decode cap (resolveDecodeHeight caps WebCodecs
 * decode at 1080/720) — an "unknown" height stays null rather than guessing,
 * because the panel's job is disclosure.
 *
 * Pure and DOM-free: testable without a browser.
 */
import { previewMaxHeight, type PreviewQuality } from "@/lib/preview/tuning";
import type { AudioClip, Composition } from "@/lib/engine/types";
import type { FileRecord } from "@/lib/db/schema/types";

function effectiveHeight(file: FileRecord, quality: PreviewQuality): number | null {
  // Mirror pickVideoUrl: a ready proxy is what the preview serves; otherwise the original.
  const proxyReady = file.proxyStatus === "ready" && file.proxyFilename != null;
  // A ready proxy with unknown encoded height (legacy pre-1080p-era row) is
  // honestly "unknown" — never guess from the source height.
  const servedHeight = proxyReady ? (file.proxyHeight ?? null) : (file.mediaHeight ?? null);
  if (servedHeight == null) return null;
  // Deliberately NOT resolveDecodeHeight: that falls back to the cap for an
  // unknown height, while this must stay null to keep the disclosure honest.
  return Math.min(servedHeight, previewMaxHeight(quality));
}

/** Source-file details for a selected audio clip (or an image overlay) — name,
 *  whether the source is a video, its native dims, and duration. Read-only. */
export interface AssetSourceDetails {
  fileId: string;
  fileName: string;
  /** "video" | "audio" | "image" | "other" — from the file's content type. */
  mediaKind: "video" | "audio" | "image" | "other";
  sourceWidth: number | null;
  sourceHeight: number | null;
  durationSec: number | null;
}

export interface AudioClipDetails {
  clip: AudioClip;
  /** The scene this inline clip follows (kind === "inline"); null otherwise. */
  /** The VIDEO OVERLAY this inline clip is attached to (linkedOverlayId); null otherwise. */
  linkedOverlayName: string | null;
  /** True when the clip is inline AND still linked to a scene or overlay. */
  attached: boolean;
  /** When NOT attached: a video overlay using this clip's source file that it
   *  could be (re-)linked to, or null when none exists. Drives "Attach to video". */
  relinkOverlayId: string | null;
  /** The clip's source file card, or null when the file list isn't loaded. */
  file: AssetSourceDetails | null;
}

function mediaKindOf(contentType: string | null): AssetSourceDetails["mediaKind"] {
  const t = contentType ?? "";
  if (t.startsWith("video")) return "video";
  if (t.startsWith("audio")) return "audio";
  if (t.startsWith("image")) return "image";
  return "other";
}

/** Read-only source details for a file id (name, kind, dims, duration). */
export function assetSourceDetails(
  fileId: string,
  files: FileRecord[] | undefined,
): AssetSourceDetails | null {
  const file = files?.find((f) => f.id === fileId);
  if (!file) return null;
  return {
    fileId: file.id,
    fileName: file.name || file.filename,
    mediaKind: mediaKindOf(file.contentType),
    sourceWidth: file.mediaWidth ?? null,
    sourceHeight: file.mediaHeight ?? null,
    durationSec: file.mediaDuration ?? null,
  };
}

/** Details for a selected audio clip — the clip itself, the scene it follows
 *  (inline), and its source file (a video file for inline clips, an audio file
 *  for standalone ones). Pure; used by the Layers inspector. */
export function audioClipDetails(
  composition: Composition | null,
  clipId: string,
  files: FileRecord[] | undefined,
): AudioClipDetails | null {
  const clip = composition?.audioClips?.find((c) => c.id === clipId);
  if (!clip) return null;
  // The video overlay this inline clip is attached to (name = its file name).
  const overlays = composition?.overlays ?? [];
  const linkedOverlay =
    clip.linkedOverlayId != null ? overlays.find((o) => o.id === clip.linkedOverlayId) : undefined;
  const linkedOverlayName =
    linkedOverlay && (linkedOverlay.kind === "video" || linkedOverlay.kind === "image")
      ? linkedOverlay.displayName?.trim() ||
        assetSourceDetails(linkedOverlay.fileId, files)?.fileName ||
        "video"
      : linkedOverlay
        ? linkedOverlay.displayName?.trim() || linkedOverlay.kind
        : null;
  const attached =
    clip.kind === "inline" && (clip.linkedSceneId != null || clip.linkedOverlayId != null);
  // When detached, offer to re-attach: prefer the REMEMBERED source video
  // (linkedOverlayId kept through detach), else any video overlay using the same
  // file.
  const relinkOverlayId =
    !attached
      ? (clip.linkedOverlayId &&
          overlays.some((o) => o.id === clip.linkedOverlayId && o.kind === "video")
          ? clip.linkedOverlayId
          : overlays.find((o) => o.kind === "video" && o.fileId === clip.fileId)?.id ?? null)
      : null;
  return {
    clip,
    linkedOverlayName,
    attached,
    relinkOverlayId,
    file: assetSourceDetails(clip.fileId, files),
  };
}

/** Details for ONE scene by index — the base scene info + its source-video
 *  card (null for canvas scenes). Used by the Layers inspector for a selected
 *  scene; `activeSceneDetails` covers the playhead + active video overlays. */
