// mcp/tools/caption-tools.ts
import { getAnalysis } from "@/lib/analysis/manager";
import { buildCaptionCues, captionCharsPerLine } from "@/lib/captions/cues";
import { anchorToRect } from "@/lib/captions/anchor";
import { addOverlayToManifest, loadManifest, saveManifest } from "@/lib/composition/persistence";
import type { PersistedAudioClip, PersistedOverlay } from "@/lib/composition/persistence";
import type { SttWord } from "@/lib/analysis/types";
import type { CaptionAnchor, CaptionCue } from "@/lib/captions/types";
import type { CaptionRevealMode } from "@/lib/engine/types";
import { overlayLogger } from "@/lib/logger";

/** Map the caption STYLE the agent requests (the reveal-oriented style names the
 *  `speech-captions` skill documents) → the renderer's per-overlay reveal mode.
 *  The renderer only animates `overlay.reveal.mode`, so this is what makes
 *  karaoke / cumulative / word-by-word / letter-by-letter actually MOVE. An
 *  explicit static style ("clean" / "static" / "none") → no reveal. Anything
 *  unrecognised falls back to the readable "cumulative" default. */
function revealModeForStyle(styleId: string): CaptionRevealMode | null {
  switch (styleId) {
    case "karaoke":
      return "karaoke";
    case "word-by-word":
      return "word-current";
    case "letter-by-letter":
      return "typewriter";
    case "clean":
    case "static":
    case "none":
      return null;
    case "cumulative":
    default:
      return "fade-words";
  }
}

/** The point-anchor where a caption's text box should sit for a 3×3 anchor,
 *  inset by a safe margin. For "bottom-center" (the default) this puts the text
 *  block's BOTTOM edge in the lower safe band so multi-line captions grow UPWARD
 *  and never overflow the canvas bottom (the "captions cut off at the bottom"
 *  bug). Pure. */
function anchorSafePoint(
  anchor: CaptionAnchor,
  frame: { width: number; height: number },
  margin = 0.06,
): { x: number; y: number } {
  const [v, h] = anchor.split("-") as [
    "top" | "mid" | "bottom",
    "left" | "center" | "right",
  ];
  const x =
    h === "left"
      ? frame.width * margin
      : h === "right"
        ? frame.width * (1 - margin)
        : frame.width / 2;
  const y =
    v === "top"
      ? frame.height * margin
      : v === "bottom"
        ? frame.height * (1 - margin)
        : frame.height / 2;
  return { x, y };
}
import type { GenerateCaptionsParams } from "./schemas";
import type { ToolResult } from "./types";

/** The end of a composition's content (in seconds), ignoring caption overlays
 *  — used as `resolveCaptionMaxEnd`'s last-resort fallback when no video
 *  overlay for the transcribed file can be found. Mirrors
 *  `getCompositionFrames` (lib/engine/renderer.ts) but in seconds rather than
 *  frames, since `buildCaptionCues`'s `maxEnd` is a seconds clamp. */
function compositionEndSeconds(
  overlays: PersistedOverlay[],
  audioClips: PersistedAudioClip[],
): number {
  const endOf = (item: { startTime?: number; duration?: number }) =>
    (item.startTime ?? 0) + (item.duration ?? 0);
  let max = 0;
  for (const o of overlays) max = Math.max(max, endOf(o));
  for (const c of audioClips) max = Math.max(max, endOf(c as { startTime?: number; duration?: number }));
  return max;
}

type VideoOverlayEntry = Extract<PersistedOverlay, { kind: "video" }>;

/** The SOURCE-time window a video overlay actually plays: `ts` is where its
 *  trim starts (0 when untrimmed), and `visible` is how much of the source it
 *  shows — the shorter of the overlay's own timeline `duration` and its trim
 *  span, mirroring `baseTimeRange` (lib/export/export-base.ts): the renderer
 *  draws for `duration` seconds starting at `trim.start`, so a trim wider
 *  than `duration` (a split-then-shortened clip) never extends what's shown. */
function visibleSourceRange(o: VideoOverlayEntry): { ts: number; visible: number } {
  const ts = o.trim?.start ?? 0;
  const visible = Math.min(o.duration, (o.trim?.end ?? Number.POSITIVE_INFINITY) - ts);
  return { ts, visible };
}

/** A cue from `buildTimelineCaptionCues`, tagged with which WINDOW (video
 *  overlay, audio clip, or the single "no window" fallback pseudo-window) it came
 *  from and that window's own `maxEnd` — so the final per-overlay duration
 *  re-clamp (the 0.2s minimum-readable-duration floor guard) uses the right
 *  end even though different windows have different ends. `windowIndex` is
 *  folded into the generated overlay id so two windows whose TIMELINE ranges
 *  happen to overlap (or a split with zero gap) can never collide on id. */
interface WindowedCaptionCue extends CaptionCue {
  windowIndex: number;
  maxEnd: number;
}

/** One place on the timeline where a file's source audio plays: timeline
 *  `startTime`, the source offset it plays from (`ts`) and how many source
 *  seconds it plays (`visible`). Both video overlays and audio clips reduce to
 *  this — neither carries a playback-rate field, so source and timeline
 *  seconds are 1:1. */
interface CaptionWindow {
  startTime: number;
  ts: number;
  visible: number;
}

/** Every window in which `fileId`'s audio is heard on the timeline.
 *
 *  - Each VIDEO overlay backing the file (a split clip is several).
 *  - Each AUDIO clip backing the file — the narration case: a voiceover is a
 *    standalone audio clip, placed by its own `startTime` and trimmed by
 *    `trimStart` (in) and `trimStart + duration` (out).
 *  - A COUPLED clip (`inline` + `linkedOverlayId` naming a matched video
 *    overlay) is that video's own sound and follows the video; its persisted
 *    timing can lag the video's (`lib/composition/audio-clips.ts` detach), so
 *    the video overlay is the window and the clip is skipped — never both, or
 *    every word would be captioned twice.
 *  - A DETACHED clip (`standalone` + `linkedOverlayId` naming a matched video
 *    overlay) is where that video's sound now plays, so the CLIP is the window
 *    and the video overlay it came from is dropped.
 *
 *  Only what the viewer can HEAR is a window (AUD-1). A video's sound exists
 *  only as its coupled inline clip — add_overlay creates it when the file has
 *  audio, `audio_remove_clip` on it is the documented way to mute the video,
 *  and every export backend takes a video's sound from its clips alone
 *  (`findBaseInlineAudioClip`). So a video with NO coupled clip is silent, as
 *  is a HIDDEN video (the eye toggle: its coupled audio is not scheduled,
 *  `lib/overlays/hidden.ts`) and one whose coupled clips are all muted. A clip
 *  switched off (`enabled: false`) or at zero volume is silent.
 *  A detached clip keeps playing when its video is hidden, so it stays a
 *  window. `silent` counts the windows skipped this way, so a file whose every
 *  window is silent is told apart from one with no window at all. */
function captionWindows(
  overlays: PersistedOverlay[],
  audioClips: PersistedAudioClip[],
  fileId: string,
): { windows: CaptionWindow[]; silent: number } {
  const videos = overlays.filter(
    (o): o is VideoOverlayEntry => o.kind === "video" && o.fileId === fileId,
  );
  const videoIds = new Set(videos.map((v) => v.id));
  const clips = audioClips.filter((c) => c.fileId === fileId);
  const detachedFrom = new Set(
    clips
      .filter((c) => c.kind === "standalone" && c.linkedOverlayId && videoIds.has(c.linkedOverlayId))
      .map((c) => c.linkedOverlayId as string),
  );
  const windows: CaptionWindow[] = [];
  let silent = 0;
  for (const v of videos) {
    if (detachedFrom.has(v.id)) continue;
    const coupled = clips.filter((c) => c.kind === "inline" && c.linkedOverlayId === v.id);
    // Heard only through an audible coupled clip; none (removed) → silent.
    if (v.hidden === true || !coupled.some(clipIsAudible)) {
      silent++;
      continue;
    }
    windows.push({ startTime: v.startTime, ...visibleSourceRange(v) });
  }
  for (const c of clips) {
    if (c.kind === "inline" && c.linkedOverlayId && videoIds.has(c.linkedOverlayId)) continue;
    if (!clipIsAudible(c)) {
      silent++;
      continue;
    }
    windows.push({ startTime: c.startTime ?? 0, ts: c.trimStart ?? 0, visible: c.duration ?? 0 });
  }
  return { windows: mergeSameMappingWindows(windows), silent };
}

/** The file's words shifted onto the piece TIMELINE across every audible
 *  window (`captionWindows`) — the same filter + shift `buildTimelineCaptionCues`
 *  uses per window. `null` when the file has NO window on the timeline (the
 *  caller falls back to source time); `[]` when every window is silent. Used by
 *  `update_overlay { captionFromFileId }`, whose overlay window is on the
 *  timeline while Whisper's words are source-file seconds. */
export function wordsOnTimeline(
  words: SttWord[],
  overlays: PersistedOverlay[],
  audioClips: PersistedAudioClip[],
  fileId: string,
): SttWord[] | null {
  const { windows, silent } = captionWindows(overlays, audioClips, fileId);
  if (windows.length === 0) return silent > 0 ? [] : null;
  const out: SttWord[] = [];
  for (const w of windows) out.push(...shiftWindowWords(words, w));
  return out.sort((a, b) => a.start - b.start);
}

/** The words a window plays (their source start inside `[ts, ts + visible)`),
 *  moved to timeline seconds (`+ startTime - ts`). */
function shiftWindowWords(words: SttWord[], { startTime, ts, visible }: CaptionWindow): SttWord[] {
  const shift = startTime - ts;
  return words
    .filter((w) => w.start >= ts && w.start < ts + visible)
    .map((w) => ({ ...w, start: w.start + shift, end: w.end + shift }));
}

/** A clip the viewer hears: switched on, at a volume above zero. */
function clipIsAudible(c: PersistedAudioClip): boolean {
  return c.enabled !== false && !((c.volume ?? 1) <= 0);
}

/** Windows that put the SAME source second at the SAME timeline second
 *  (equal `startTime - ts`) and OVERLAP in source play the same words at the
 *  same moment — e.g. an unlinked audio clip of a video's own file lined up
 *  with that video. Merge them into their union so each word is captioned
 *  once, whatever links (or doesn't) the two. Merely ADJACENT windows stay
 *  separate: that is a split clip, whose halves are captioned independently
 *  by design. Windows with different shifts (a duplicate moved elsewhere)
 *  really do play the words twice and are left alone. */
function mergeSameMappingWindows(windows: CaptionWindow[]): CaptionWindow[] {
  const EPS = 1e-6;
  const shiftOf = (w: CaptionWindow) => w.startTime - w.ts;
  const sorted = [...windows].sort((a, b) => shiftOf(a) - shiftOf(b) || a.ts - b.ts);
  const out: CaptionWindow[] = [];
  for (const w of sorted) {
    const prev = out[out.length - 1];
    if (
      prev &&
      Math.abs(shiftOf(prev) - shiftOf(w)) < EPS &&
      w.ts < prev.ts + prev.visible - EPS
    ) {
      const end = Math.max(prev.ts + prev.visible, w.ts + w.visible);
      prev.visible = end - prev.ts;
      continue;
    }
    out.push({ ...w });
  }
  return out;
}

/**
 * Builds ALL of a transcript's caption cues, placed on the piece's TIMELINE —
 * across every video overlay AND audio clip backing `fileId`
 * (`captionWindows`), not just one chosen overlay.
 *
 * `readWordsFromAnalysis` transcribes the full, untrimmed ORIGINAL file
 * (`lib/analysis/manager.ts` `extractAudio`), so `SttWord.start`/`end` are
 * SOURCE-file-relative seconds — not the piece's timeline. A caption overlay,
 * like every other overlay, is placed on the timeline via its own
 * `startTime`/`duration`; getting that right for a window that is trimmed
 * (`trim.start` / `trimStart` !== 0) or positioned away from t=0
 * (`startTime !== 0`) requires converting:
 * `timelineTime = sourceTime - trimIn + startTime` (the inverse of the
 * renderer's own `sourceTime = timelineTime - startTime + trim.start`, see
 * `lib/engine/renderer.ts`/`overlay-renderer.ts`). An earlier version mapped
 * only through VIDEO overlays, so a narration audio clip (the normal
 * voiceover case) took the "no window" branch and captioned at raw source
 * time — early by the clip's `startTime`, and the wrong words when trimmed.
 *
 * A file backs more than one window whenever a clip has been split
 * (`lib/composition/clip-ops.ts` `splitOverlay`): the head and tail share the
 * SAME `fileId` with adjacent, non-overlapping `trim` windows. There is no
 * single "the" window: each is captioned independently — its own visible
 * source range, its own word filter + shift, and its own `buildCaptionCues`
 * call with that window's own `minStart`/`maxEnd` — then every window's cues
 * are concatenated and sorted by start. A word that falls in NO window (cut
 * material — spoken during a stretch nothing plays) is dropped.
 *
 * When no window for `fileId` exists at all, there is no timeline to convert
 * onto, so the words pass through unchanged as a single pseudo-window
 * (index 0) and the clamp falls back to the composition's own end (excluding
 * the caption track about to be replaced) — but only when that end is
 * actually known (> 0); a piece with nothing else on it yet has no
 * established length to clamp against, so `Infinity` (no clamp) is the
 * sensible choice there rather than truncating every fresh caption to 0.
 */
function buildTimelineCaptionCues(
  words: SttWord[],
  overlaysBeforeReplace: PersistedOverlay[],
  fileId: string,
  overlaysAfterReplace: PersistedOverlay[],
  audioClips: PersistedAudioClip[],
  cueOpts: { maxLines: number; maxCharsPerLine: number },
): { cues: WindowedCaptionCue[]; allSilent: boolean } {
  const { windows, silent } = captionWindows(overlaysBeforeReplace, audioClips, fileId);

  // The file IS on the timeline, but nowhere it can be heard: no cues — never
  // the raw-source-time fallback below, which would caption silence.
  if (windows.length === 0 && silent > 0) return { cues: [], allSilent: true };

  if (windows.length === 0) {
    const fallback = compositionEndSeconds(overlaysAfterReplace, audioClips);
    const maxEnd = fallback > 0 ? fallback : Number.POSITIVE_INFINITY;
    const cues = buildCaptionCues(words, { ...cueOpts, maxEnd, minStart: 0 }).map((c) => ({
      ...c,
      windowIndex: 0,
      maxEnd,
    }));
    return { cues, allSilent: false };
  }

  const allCues: WindowedCaptionCue[] = [];
  windows.forEach((window, windowIndex) => {
    const { startTime, visible } = window;
    const windowWords = shiftWindowWords(words, window);
    const maxEnd = startTime + visible;
    const windowCues = buildCaptionCues(windowWords, { ...cueOpts, maxEnd, minStart: startTime });
    allCues.push(...windowCues.map((c) => ({ ...c, windowIndex, maxEnd })));
  });
  allCues.sort((a, b) => a.start - b.start);
  return { cues: allCues, allSilent: false };
}

/** Read the file's full word-level transcript by concatenating the analysis
 *  audio chunks in order. Mirrors `analysisGetAudioChunks`'s read path
 *  (`getAnalysis({ fileId })` → `bundle.audioChunks`). Each chunk's `words` is
 *  a JSON-stringified `SttWord[]` (or null). */
export async function readWordsFromAnalysis(fileId: string): Promise<SttWord[]> {
  const bundle = await getAnalysis({ fileId });
  const chunks = [...bundle.audioChunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const words: SttWord[] = [];
  for (const chunk of chunks) {
    if (!chunk.words) continue;
    try {
      const parsed = JSON.parse(chunk.words) as SttWord[];
      if (Array.isArray(parsed)) words.push(...parsed);
    } catch {
      // Skip a chunk with malformed words JSON rather than failing the whole track.
    }
  }
  return words;
}

export interface GenerateCaptionsDeps {
  /** Injectable for tests; defaults to the real analysis-chunk read path. */
  readWords: (fileId: string) => Promise<SttWord[]>;
}

const defaultDeps: GenerateCaptionsDeps = { readWords: readWordsFromAnalysis };

/** Build a styled, timed caption track (a set of text overlays sharing a
 *  `caption.groupId`) from a file's existing word-level transcript timings. */
export async function generateCaptions(
  params: GenerateCaptionsParams,
  deps: GenerateCaptionsDeps = defaultDeps,
): Promise<ToolResult> {
  const { pieceId, fileId } = params;

  const words = await deps.readWords(fileId);
  const spoken = words.filter((w) => (w.type ?? "word") === "word" && w.text.trim().length > 0);
  if (spoken.length === 0) {
    return {
      success: false,
      error: "no_transcript",
      data: { hint: "Run the audio-analysis/transcript step first." },
    };
  }

  const manifest = await loadManifest(pieceId);
  const frame = { width: manifest.width, height: manifest.height };

  // Stable, per-file group id (NOT per-cue-count) so a restyle / regeneration
  // targets the SAME track for replacement regardless of how many cues it yields.
  const groupId = `cap-${fileId}`;

  // REPLACE any existing caption track for this file — re-running (e.g. a
  // restyle) must update the same track in place, never append a duplicate.
  // Appending previously produced doubled overlays with colliding ids → React
  // duplicate-key errors + an unremovable-by-id track. Match by the per-file
  // `cap-<fileId>` PREFIX so legacy tracks (old `cap-<fileId>-<cueCount>` group
  // ids) are replaced too, not just exact-current-group matches.
  // Computed BEFORE the cues themselves so `resolveCaptionMaxEnd`'s
  // "composition end without captions" fallback excludes any track we are
  // about to replace.
  const existingOverlays = manifest.overlays ?? [];
  // `cap-<fileId>-custom` is the user's OWN caption (a code/three overlay
  // attached with `update_overlay { captionFromFileId }`), not a cue of this
  // track — re-running must never delete it.
  const kept = existingOverlays.filter((o) => {
    const gid = (o as { caption?: { groupId?: string } }).caption?.groupId;
    if (gid === `${groupId}-custom`) return true;
    return !(gid && gid.startsWith(groupId));
  });

  // Canvas-scaled, bottom-safe placement (the "cut off at the bottom" fix).
  // Font scales with frame height (~5.5%) instead of a hardcoded 48px, so a
  // 480p clip and a 1080p clip both read well. Captions are authored in the
  // NEW point-text model (anchor + position + maxWidthPct) so `build-composition`
  // never legacy-normalizes them to mid-center — a bottom caption stays at the
  // bottom and multi-line text grows upward.
  // The font is fixed BEFORE the cues are split: each cue's line budget comes
  // from it and the canvas width, so a 9:16 cue (90 px on 1080 wide) never
  // wraps past its `maxLinesPerCue` lines (the eval's 3-line, 324 px cue).
  const fontSize = Math.max(20, Math.min(90, Math.round(frame.height * 0.055)));
  const maxWidthPct = 0.9;
  const charsPerLine = captionCharsPerLine(frame.width, fontSize);

  const { cues, allSilent } = buildTimelineCaptionCues(
    words,
    existingOverlays,
    fileId,
    kept,
    manifest.audioClips ?? [],
    { maxLines: params.maxLinesPerCue ?? 2, maxCharsPerLine: charsPerLine },
  );

  const styleId = params.style ?? "cumulative";
  const revealMode = revealModeForStyle(styleId);

  const anchor: CaptionAnchor = (params.anchor ?? "bottom-center") as CaptionAnchor;
  const position = anchorSafePoint(anchor, frame);
  // Keep a rect for back-compat readers; the renderer uses anchor+position.
  const size = {
    width: Math.round(frame.width * maxWidthPct),
    height: Math.round(frame.height * 0.12),
  };
  const rect = anchorToRect(anchor, frame, size);

  const removedCueCount = existingOverlays.length - kept.length;
  if (kept.length !== existingOverlays.length) {
    manifest.overlays = kept;
    await saveManifest(pieceId, manifest);
  }

  // A transcript can exist (the earlier no_transcript guard passed) yet have
  // no word fall inside ANY window (video overlay or audio clip) — e.g. captioning
  // a file whose only matching overlay(s) were trimmed to a range the speech
  // isn't in. That's not a tool failure: report it so the agent can tell the
  // user, rather than silently creating an empty (0-cue) track. The hint is a
  // full sentence (like the other hints in mcp/tools) so the agent can relay
  // it verbatim instead of translating an enum token for the user.
  if (cues.length === 0) {
    const removedNote =
      removedCueCount > 0
        ? ` The previous caption track (${removedCueCount} ${removedCueCount === 1 ? "cue" : "cues"}) was removed.`
        : "";
    const hint = allSilent
      ? "Every video overlay and audio clip for this file is hidden, muted or has had its audio removed, " +
        "so nothing of it is heard; no captions were created. Caption the file that IS heard instead " +
        "(e.g. a replacement voiceover: pass that audio clip's own fileId)." + removedNote
      : removedCueCount > 0
        ? `No speech falls inside the playing part of any video overlay or audio clip for this file; ` +
          `no captions were created and the previous caption track (${removedCueCount} ` +
          `${removedCueCount === 1 ? "cue" : "cues"}) was removed.`
        : "No speech falls inside the playing part of any video overlay or audio clip for this file; no captions were created.";
    return {
      success: true,
      data: { captionGroupId: groupId, cueCount: 0, removedCueCount, hint },
    };
  }

  for (const c of cues) {
    // Real per-word timings, ELEMENT-LOCAL (relative to this cue's startTime),
    // so the renderer's time-synced reveals emphasize the actually-spoken word
    // instead of guessing by even spacing. Clamp to ≥0 (the lead-in means the
    // first word's local start ≈ the lead, never negative).
    const cueWords = (c.words ?? []).map((w) => ({
      // Trimmed to match `c.text` (also trimmed — see cues.ts `flush()`), so
      // a word's stored text never carries a leading/trailing space some STT
      // backends emit that the cue's own joined text no longer has.
      text: w.text.trim(),
      start: Math.max(0, Number((w.start - c.start).toFixed(3))),
      end: Math.max(0, Number((w.end - c.start).toFixed(3))),
    }));
    // `buildCaptionCues` already clamps `c.end` to this cue's own window's
    // `maxEnd`, but the 0.2s MINIMUM readable-duration floor below could
    // still push a very-late cue back past it — re-clamp against that SAME
    // `maxEnd` (per-window, since different windows have different ends) so
    // the overlay itself never outlives its video.
    const rawDuration = Math.max(0.2, c.end - c.start);
    const duration = Math.min(rawDuration, Math.max(0, c.maxEnd - c.start));
    await addOverlayToManifest(pieceId, {
      // The window index guards against an id collision when two windows'
      // TIMELINE ranges overlap (or, degenerately, land on the exact same
      // rounded millisecond) — each window's cues are otherwise numbered
      // independently by their own (post-shift) start time.
      id: `cue-${groupId}-w${c.windowIndex}-${Math.round(c.start * 1000)}`,
      kind: "text",
      startTime: c.start,
      duration,
      rect,
      anchor,
      position,
      maxWidthPct,
      fontSize,
      z: params.z ?? 50,
      opacity: 1,
      content: c.text,
      font: `${fontSize}px Inter`,
      // Readable default look (white + soft shadow); reveal drives the motion.
      color: "#ffffff",
      align: "center",
      shadow: { color: "rgba(0,0,0,0.55)", blur: 8, dx: 0, dy: 2 },
      ...(revealMode ? { reveal: { mode: revealMode } } : {}),
      caption: {
        groupId,
        styleRef: styleId,
        useTrackStyle: true,
        ...(cueWords.length > 0 ? { words: cueWords } : {}),
      },
    });
  }

  overlayLogger.info(
    {
      event: "generate_captions",
      pieceId,
      fileId,
      groupId,
      cueCount: cues.length,
      styleId,
      revealMode,
      anchor,
      fontSize,
      charsPerLine,
    },
    "overlay.generate_captions",
  );

  return { success: true, data: { captionGroupId: groupId, cueCount: cues.length } };
}
