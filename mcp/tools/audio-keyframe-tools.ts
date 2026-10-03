/**
 * Volume keyframes on AUDIO clips, behind the same tools as overlay keyframes
 * (`libi.add_keyframe`, `libi.keyframe`): a call names an `overlayId` or a
 * `clipId`. Times are SECONDS from the clip's start, stored as such (an
 * overlay's are normalized to its length, but a bed's dip has to stay where the
 * narration is when the clip's tail is trimmed). Values are dB OFFSETS on top of
 * the clip's `gainDb`. The curve itself is `lib/audio/clip-gain.ts`.
 */
import { loadManifest, saveManifest } from "@/lib/composition/persistence";
import { updateClip } from "@/lib/composition/audio-clips";
import { isValidEasing } from "@/lib/engine/easing-registry";
import { upsertVolumeKey, volumeKeyIndexAt } from "@/lib/audio/clip-gain";
import type { ToolResult } from "./types";
import type {
  AddKeyframeParams,
  DeleteKeyframeParams,
  SetKeyframeEasingParams,
  ListKeyframesParams,
} from "./schemas";

/** The one-of check shared by every keyframe action; null when exactly one target is named. */
export function keyframeTargetError(p: { overlayId?: string; clipId?: string }): string | null {
  if (p.overlayId !== undefined && p.clipId !== undefined) return "pass overlayId OR clipId, not both";
  if (p.overlayId === undefined && p.clipId === undefined) {
    return "name the target: overlayId (an overlay) or clipId (an audio clip's volume envelope)";
  }
  return null;
}

async function loadClip(pieceId: string, clipId: string) {
  const manifest = await loadManifest(pieceId);
  const clip = (manifest.audioClips ?? []).find((c) => c.id === clipId);
  return { manifest, clip };
}

const notFound = (clipId: string): ToolResult => ({ success: false, error: `audio clip ${clipId} not found` });
const outOfRange = (time: number, duration: number): ToolResult => ({
  success: false,
  error: `time ${time}s is out of range for the clip window [0, ${duration}]s`,
});

async function write(pieceId: string, clipId: string, keyframes: { keyframes: { t: number; value: number; easing?: string }[] } | undefined): Promise<boolean> {
  const manifest = await loadManifest(pieceId);
  const next = updateClip(manifest, clipId, { volumeKeyframes: keyframes } as never);
  if (!next) return false;
  await saveManifest(pieceId, next);
  return true;
}

export async function addClipKeyframe(params: AddKeyframeParams): Promise<ToolResult> {
  const { pieceId, clipId, time, properties, easing } = params;
  const id = clipId!;
  if (easing !== undefined && !isValidEasing(easing)) return { success: false, error: `invalid easing "${easing}"` };
  const others = Object.entries(properties ?? {}).filter(([k, v]) => k !== "volumeDb" && v !== undefined).map(([k]) => k);
  if (others.length > 0) {
    return { success: false, error: `an audio clip keys volumeDb only (not ${others.join(", ")})` };
  }
  if (properties?.volumeDb === undefined) {
    return { success: false, error: "an audio clip keyframe needs properties: { volumeDb } (dB offset on top of gainDb; 0 = unchanged)" };
  }
  const { clip } = await loadClip(pieceId, id);
  if (!clip) return notFound(id);
  if (time > clip.duration) return outOfRange(time, clip.duration);
  const track = upsertVolumeKey(clip.volumeKeyframes, time, properties.volumeDb, easing);
  const landed = track.keyframes[volumeKeyIndexAt(track, time)];
  if (!(await write(pieceId, id, track))) return notFound(id);
  return {
    success: true,
    data: { clipId: id, time: landed.t, volumeDb: landed.value, ...(landed.easing ? { easing: landed.easing } : {}), keys: track.keyframes.length },
  };
}

export async function deleteClipKeyframe(params: DeleteKeyframeParams): Promise<ToolResult> {
  const { pieceId, time } = params;
  const id = params.clipId!;
  const { clip } = await loadClip(pieceId, id);
  if (!clip) return notFound(id);
  const at = volumeKeyIndexAt(clip.volumeKeyframes, time);
  if (at === -1) return { success: false, error: `no keyframe at ${time}s` };
  const keys = clip.volumeKeyframes!.keyframes.filter((_, i) => i !== at);
  if (!(await write(pieceId, id, keys.length > 0 ? { keyframes: keys } : undefined))) return notFound(id);
  return { success: true, data: { clipId: id, time: clip.volumeKeyframes!.keyframes[at].t, keys: keys.length } };
}

export async function setClipKeyframeEasing(params: SetKeyframeEasingParams): Promise<ToolResult> {
  const { pieceId, time, easing } = params;
  const id = params.clipId!;
  if (!isValidEasing(easing)) return { success: false, error: `invalid easing "${easing}"` };
  const { clip } = await loadClip(pieceId, id);
  if (!clip) return notFound(id);
  const at = volumeKeyIndexAt(clip.volumeKeyframes, time);
  if (at === -1) return { success: false, error: `no keyframe at ${time}s` };
  const keys = clip.volumeKeyframes!.keyframes.map((k, i) => (i === at ? { ...k, easing } : k));
  if (!(await write(pieceId, id, { keyframes: keys }))) return notFound(id);
  return { success: true, data: { clipId: id, time: keys[at].t, easing } };
}

export async function listClipKeyframes(params: ListKeyframesParams): Promise<ToolResult> {
  const id = params.clipId!;
  const { clip } = await loadClip(params.pieceId, id);
  if (!clip) return notFound(id);
  const keys = clip.volumeKeyframes?.keyframes ?? [];
  return {
    success: true,
    data: {
      clipId: id,
      duration: clip.duration,
      ...(clip.gainDb ? { gainDb: clip.gainDb } : {}),
      times: keys.map((k) => k.t),
      tracks: keys.length > 0 ? { volumeDb: keys.map((k) => ({ time: k.t, db: k.value, ...(k.easing ? { easing: k.easing } : {}) })) } : {},
    },
  };
}

