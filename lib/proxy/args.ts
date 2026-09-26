import { leadFill, onFileTimeline } from "@/lib/export/export-base";
export interface BuildProxyOptions {
  /** Source fps. GOP size = fps (one keyframe per second). */
  fps: number;
  /** ffprobe index of the source's primary video stream (`probeMedia`'s
   *  primaryVideoStreamIndex). Unknown → the first real video stream. */
  videoStream?: number;
  /** ffprobe index of the source's primary audio stream — the one the
   *  preview decodes. Unknown → the first audio stream, if any. */
  audioStream?: number;
  /** Seconds after the source file's start its primary video starts
   *  (`probeMedia`'s videoLead). */
  videoLead?: number;
  /** How the source's audio is read onto its timeline when ffmpeg must read
   *  it with options of its own (`probeMedia`'s audioRead: a FLAC-in-MP4 cut).
   *  The audio then comes from a second input of the same file. */
  audioRead?: { inputArgs: string[]; ptsShift: number };
}

/** The streams a proxy of `probed` must carry (see BuildProxyOptions). */
export function proxyStreamsFor(probed: {
  primaryVideoStreamIndex?: number;
  primaryAudioStreamIndex?: number;
  videoLead?: number;
  audioRead?: { inputArgs: string[]; ptsShift: number };
}): Pick<BuildProxyOptions, "videoStream" | "audioStream" | "videoLead" | "audioRead"> {
  return {
    ...(probed.primaryVideoStreamIndex !== undefined ? { videoStream: probed.primaryVideoStreamIndex } : {}),
    ...(probed.primaryAudioStreamIndex !== undefined ? { audioStream: probed.primaryAudioStreamIndex } : {}),
    ...(probed.videoLead ? { videoLead: probed.videoLead } : {}),
    ...(probed.audioRead?.inputArgs.length ? { audioRead: probed.audioRead } : {}),
  };
}

/**
 * Build the ffmpeg args for generating a scrub-friendly preview proxy.
 *
 * Target: resolution-aware H.264 yuv420p, 1 keyframe/sec, faststart for
 * streaming. CRF 23 is a sensible quality/size balance for editing.
 *
 * Proxy height = `min(sourceHeight, 1080)`:
 *   - ≤1080p sources (essentially all AI-generated clips) are re-encoded at
 *     their **native resolution** — scrub-friendly GOP, zero visible downgrade.
 *   - >1080p sources (e.g. 4K uploads) are downscaled to 1080p.
 */
export function buildProxyArgs(
  inputPath: string,
  outputPath: string,
  opts: BuildProxyOptions,
): string[] {
  const gop = Math.max(1, Math.round(opts.fps));
  const ownAudioInput = !!opts.audioRead?.inputArgs.length;
  const audioSpec = opts.audioStream !== undefined ? `${ownAudioInput ? 1 : 0}:${opts.audioStream}` : `${ownAudioInput ? 1 : 0}:a:0?`;
  return [
    "-y",
    "-i", inputPath,
    ...(ownAudioInput ? [...opts.audioRead!.inputArgs, "-i", inputPath] : []),
    // Explicit streams, so the proxy carries the audio the preview reads from
    // the original: mediabunny's primary track (the first `default`-flagged
    // one, else the first). Without -map, ffmpeg picks by its own rules, e.g.
    // the stream with the most channels (Review M6). The fallback specs cover
    // a failed probe: `V` is the first real video stream (never cover art), and
    // `?` keeps a video with no audio proxyable.
    "-map", opts.videoStream !== undefined ? `0:${opts.videoStream}` : "0:V:0",
    "-map", audioSpec,
    // Height-capped at 1080, aspect preserved, and BOTH output dimensions rounded
    // down to an even integer — libx264/yuv420p rejects odd width OR height with
    // "Could not open encoder … Invalid argument". The previous
    // `min(iw,trunc(iw*1080/ih/2)*2)` form only rounded the DOWNSCALE branch: a
    // ≤1080p source kept its native `iw`/`ih` untouched, so any odd-width source
    // (e.g. an 853×480 clip) failed proxy generation outright. Deriving the
    // target height first (`min(ih,1080)`), scaling width to match, then
    // even-truncating each keeps aspect, never upscales, and is always even.
    //
    // The proxy starts where its source does. The preview reads a proxy's
    // source time 0 from its first timestamp (source-time-origin.ts), and
    // ffmpeg starts the output at the first stream's first packet. So for a
    // source whose streams all start after the file (a subtitle first: both
    // 0.4 s late), the proxy started at 0.38 s and the preview played it that
    // much early. The video's first frame fills its lead (`leadFill`), as the
    // preview and the export show it, and the audio's lead is silence.
    // docs-local/qa/2026-09-25-mediabunny-upgrade-report.md (Export lead fix)
    "-vf", `${leadFill(opts.videoLead ?? 0)}scale='trunc(iw*min(ih,1080)/ih/2)*2':'trunc(min(ih,1080)/2)*2'`,
    "-af", onFileTimeline(opts.audioRead?.ptsShift),
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "23",
    "-g", String(gop),
    "-keyint_min", String(gop),
    "-sc_threshold", "0",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    outputPath,
  ];
}

/**
 * ffmpeg args for an AUDIO file's proxy: its primary audio as AAC-LC in an
 * M4A, on the file's timeline (review round 4). Made only for a file the
 * preview can't play itself (lib/ffmpeg/audio-preview.ts): the preview's
 * audio engine falls back to it as it does to a video proxy's audio. It
 * reads the audio alone, so it takes the file's `audioRead` like every other
 * audio-only ffmpeg read (an Ogg stream that starts late keeps its lead).
 */
export function buildAudioProxyArgs(
  inputPath: string,
  outputPath: string,
  opts: Pick<BuildProxyOptions, "audioStream" | "audioRead">,
): string[] {
  return [
    "-y",
    ...(opts.audioRead?.inputArgs ?? []),
    "-i", inputPath,
    "-map", opts.audioStream !== undefined ? `0:${opts.audioStream}` : "0:a:0",
    "-vn",
    "-af", onFileTimeline(opts.audioRead?.ptsShift),
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    outputPath,
  ];
}
