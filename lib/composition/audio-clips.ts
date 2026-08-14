import type {
  CompositionManifest,
  PersistedAudioClip,
} from "@/lib/composition/persistence";

/** Append a clip. Returns a new manifest (immutable). */
export function addClip(
  m: CompositionManifest,
  clip: PersistedAudioClip,
): CompositionManifest {
  return { ...m, audioClips: [...(m.audioClips ?? []), clip] };
}

export type AudioClipPatch = Partial<Omit<PersistedAudioClip, "id">>;

/** Apply a patch to a single clip. Returns null if the id is missing. */
export function updateClip(
  m: CompositionManifest,
  clipId: string,
  patch: AudioClipPatch,
): CompositionManifest | null {
  const clips = m.audioClips ?? [];
  const idx = clips.findIndex((c) => c.id === clipId);
  if (idx === -1) return null;
  const next = [...clips];
  next[idx] = { ...next[idx], ...patch };
  return { ...m, audioClips: next };
}

/** Drop a clip by id. Returns null if missing. */
export function removeClip(
  m: CompositionManifest,
  clipId: string,
): CompositionManifest | null {
  const clips = m.audioClips ?? [];
  if (!clips.some((c) => c.id === clipId)) return null;
  return { ...m, audioClips: clips.filter((c) => c.id !== clipId) };
}

/** Convert an inline clip to standalone — drops `linkedSceneId`. Returns
 *  null if the clip doesn't exist or is already standalone. */
export function unlinkClip(
  m: CompositionManifest,
  clipId: string,
): CompositionManifest | null {
  const clips = m.audioClips ?? [];
  const idx = clips.findIndex((c) => c.id === clipId);
  if (idx === -1) return null;
  if (clips[idx].kind === "standalone") return null;
  const next = [...clips];
  // Detaching flips the clip to `standalone` but KEEPS `linkedOverlayId` — a
  // detached overlay-audio still REMEMBERS its source video so the timeline can
  // keep it parked under that video and name it "detached audio of video — X"
  // (and offer one-click re-attach). Only the SCENE link is dropped (scene audio
  // has no detached-but-remembered concept). The coupling read distinguishes by
  // `kind`: inline+linkedOverlayId = coupled (moves together);
  // standalone+linkedOverlayId = detached (independent, parked under the video).
  const { linkedSceneId, ...rest } = next[idx];
  void linkedSceneId;
  // SNAP-ON-DETACH: a COUPLED strip renders positioned by the VIDEO's window,
  // while a DETACHED clip renders by its OWN startTime/duration/trimStart. If the
  // clip's persisted timing drifted from the video's (e.g. the video was moved
  // while coupled — the strip followed visually but the clip row wasn't
  // re-saved), detaching would VISIBLY JUMP the clip to its stale timing. Snap
  // the clip to the linked video's CURRENT window here, server-side, so the
  // detached clip materializes exactly where the coupled strip was shown. No-op
  // when the link is missing/orphaned (keep the clip's own timing).
  const overlay = rest.linkedOverlayId
    ? ((m.overlays ?? []).find((o) => o.id === rest.linkedOverlayId && o.kind === "video") as
        | { startTime: number; duration: number; z: number; trim?: { start: number } }
        | undefined)
    : undefined;
  next[idx] = {
    ...rest,
    kind: "standalone",
    ...(overlay
      ? {
          startTime: overlay.startTime,
          duration: overlay.duration,
          trimStart: overlay.trim?.start ?? rest.trimStart,
          // SEED THE VERTICAL ORDER: a detached track is independent on the
          // SAME axis as overlay `z`. Sort it directly BELOW its source video
          // (z − 0.5) so it materializes in the row right under the video at the
          // moment of detach (no vertical teleport). No-op when the link is
          // orphaned (no `z` to anchor against).
          timelineOrder: overlay.z - 0.5,
        }
      : {}),
  };
  return { ...m, audioClips: next };
}

/**
 * Re-attach a standalone clip to a VIDEO OVERLAY (the inverse of unlinkClip for
 * the overlay case): flip it back to `inline`, set `linkedOverlayId`, and snap
 * its timing to the overlay's current window so they read as one combined track
 * again. Returns null when the clip or a video overlay with `overlayId` is
 * missing.
 */
export function relinkClipToOverlay(
  m: CompositionManifest,
  clipId: string,
  overlayId: string,
): CompositionManifest | null {
  const clips = m.audioClips ?? [];
  const idx = clips.findIndex((c) => c.id === clipId);
  if (idx === -1) return null;
  const overlay = (m.overlays ?? []).find((o) => o.id === overlayId && o.kind === "video") as
    | { id: string; startTime: number; duration: number; trim?: { start: number } }
    | undefined;
  if (!overlay) return null;
  const next = [...clips];
  const { linkedSceneId, timelineOrder, ...rest } = next[idx];
  void linkedSceneId;
  void timelineOrder;
  next[idx] = {
    ...rest,
    kind: "inline",
    linkedOverlayId: overlayId,
    startTime: overlay.startTime,
    duration: overlay.duration,
    trimStart: overlay.trim?.start ?? rest.trimStart,
    // Coupled audio is positioned by the video, not by `timelineOrder` — drop
    // the detached-track vertical key so a later re-detach starts fresh.
    timelineOrder: undefined,
  };
  return { ...m, audioClips: next };
}

/**
 * Split a clip into two at composition time `t`. The original keeps its
 * id and shrinks; the new clip starts at `t` with a fresh id.
 */
export function splitClip(
  m: CompositionManifest,
  clipId: string,
  t: number,
): CompositionManifest | null {
  const clips = m.audioClips ?? [];
  const idx = clips.findIndex((c) => c.id === clipId);
  if (idx === -1) return null;
  const orig = clips[idx];
  const localOffset = t - orig.startTime;
  if (localOffset <= 0 || localOffset >= orig.duration) return null;

  const head: PersistedAudioClip = {
    ...orig,
    duration: localOffset,
  };
  const tail: PersistedAudioClip = {
    ...orig,
    id: `clip_${Math.random().toString(36).substring(2, 10)}`,
    startTime: t,
    duration: orig.duration - localOffset,
    trimStart: orig.trimStart + localOffset,
  };

  const next = [...clips];
  next.splice(idx, 1, head, tail);
  return { ...m, audioClips: next };
}

/** Find the inline AudioClip linked to a given scene id, or null. */
export function findInlineClipForScene(
  m: CompositionManifest,
  sceneId: string,
): PersistedAudioClip | null {
  return (m.audioClips ?? []).find(
    (c) => c.kind === "inline" && c.linkedSceneId === sceneId,
  ) ?? null;
}

/** Find the inline AudioClip linked to a given video-overlay id, or null. */
export function findInlineClipForOverlay(
  m: CompositionManifest,
  overlayId: string,
): PersistedAudioClip | null {
  return (m.audioClips ?? []).find(
    (c) => c.kind === "inline" && c.linkedOverlayId === overlayId,
  ) ?? null;
}
