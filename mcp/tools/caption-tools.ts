// mcp/tools/caption-tools.ts
import { getAnalysis } from "@/lib/analysis/manager";
import { buildCaptionCues } from "@/lib/captions/cues";
import { anchorToRect } from "@/lib/captions/anchor";
import { addOverlayToManifest, loadManifest, saveManifest } from "@/lib/composition/persistence";
import type { ElevenLabsWord } from "@/lib/elevenlabs/transcribe";
import type { CaptionAnchor } from "@/lib/captions/types";
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

/** Read the file's full word-level transcript by concatenating the analysis
 *  audio chunks in order. Mirrors `analysisGetAudioChunks`'s read path
 *  (`getAnalysis({ fileId })` → `bundle.audioChunks`). Each chunk's `words` is
 *  a JSON-stringified `ElevenLabsWord[]` (or null). */
export async function readWordsFromAnalysis(fileId: string): Promise<ElevenLabsWord[]> {
  const bundle = await getAnalysis({ fileId });
  const chunks = [...bundle.audioChunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const words: ElevenLabsWord[] = [];
  for (const chunk of chunks) {
    if (!chunk.words) continue;
    try {
      const parsed = JSON.parse(chunk.words) as ElevenLabsWord[];
      if (Array.isArray(parsed)) words.push(...parsed);
    } catch {
      // Skip a chunk with malformed words JSON rather than failing the whole track.
    }
  }
  return words;
}

export interface GenerateCaptionsDeps {
  /** Injectable for tests; defaults to the real analysis-chunk read path. */
  readWords: (fileId: string) => Promise<ElevenLabsWord[]>;
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

  const cues = buildCaptionCues(words, { maxLines: params.maxLinesPerCue ?? 2 });
  // Stable, per-file group id (NOT per-cue-count) so a restyle / regeneration
  // targets the SAME track for replacement regardless of how many cues it yields.
  const groupId = `cap-${fileId}`;

  const styleId = params.style ?? "cumulative";
  const revealMode = revealModeForStyle(styleId);

  // Canvas-scaled, bottom-safe placement (the "cut off at the bottom" fix).
  // Font scales with frame height (~5.5%) instead of a hardcoded 48px, so a
  // 480p clip and a 1080p clip both read well. Captions are authored in the
  // NEW point-text model (anchor + position + maxWidthPct) so `build-composition`
  // never legacy-normalizes them to mid-center — a bottom caption stays at the
  // bottom and multi-line text grows upward.
  const anchor: CaptionAnchor = (params.anchor ?? "bottom-center") as CaptionAnchor;
  const fontSize = Math.max(20, Math.min(90, Math.round(frame.height * 0.055)));
  const maxWidthPct = 0.9;
  const position = anchorSafePoint(anchor, frame);
  // Keep a rect for back-compat readers; the renderer uses anchor+position.
  const size = {
    width: Math.round(frame.width * maxWidthPct),
    height: Math.round(frame.height * 0.12),
  };
  const rect = anchorToRect(anchor, frame, size);

  // REPLACE any existing caption track for this file — re-running (e.g. a
  // restyle) must update the same track in place, never append a duplicate.
  // Appending previously produced doubled overlays with colliding ids → React
  // duplicate-key errors + an unremovable-by-id track. Match by the per-file
  // `cap-<fileId>` PREFIX so legacy tracks (old `cap-<fileId>-<cueCount>` group
  // ids) are replaced too, not just exact-current-group matches.
  const existingOverlays = manifest.overlays ?? [];
  const kept = existingOverlays.filter((o) => {
    const gid = (o as { caption?: { groupId?: string } }).caption?.groupId;
    return !(gid && gid.startsWith(groupId));
  });
  if (kept.length !== existingOverlays.length) {
    manifest.overlays = kept;
    await saveManifest(pieceId, manifest);
  }

  for (const c of cues) {
    // Real per-word timings, ELEMENT-LOCAL (relative to this cue's startTime),
    // so the renderer's time-synced reveals emphasize the actually-spoken word
    // instead of guessing by even spacing. Clamp to ≥0 (the lead-in means the
    // first word's local start ≈ the lead, never negative).
    const cueWords = (c.words ?? []).map((w) => ({
      text: w.text,
      start: Math.max(0, Number((w.start - c.start).toFixed(3))),
      end: Math.max(0, Number((w.end - c.start).toFixed(3))),
    }));
    await addOverlayToManifest(pieceId, {
      id: `cue-${groupId}-${Math.round(c.start * 1000)}`,
      kind: "text",
      startTime: c.start,
      duration: Math.max(0.2, c.end - c.start),
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
    },
    "overlay.generate_captions",
  );

  return { success: true, data: { captionGroupId: groupId, cueCount: cues.length } };
}
