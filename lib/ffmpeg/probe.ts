/**
 * ffprobe-based media metadata extraction. Used at upload time (so the
 * `files` row gets the truth about audio presence + dimensions + alpha).
 *
 * Returns `{}` when ffprobe isn't on PATH or the file is unreadable —
 * callers must treat each field as "unknown if absent" rather than
 * "false / zero".
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { resolveFfprobePath } from "@/lib/ffmpeg/exec";
import { streamHasAlpha } from "@/lib/ffmpeg/alpha";
import { codecDelayOfStream, readMatroskaTrackFlags, unlistedStreamIndexes } from "@/lib/ffmpeg/matroska-tracks";

export interface ProbedMedia {
  duration?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  /** ffprobe `codec_name` of the PRIMARY audio stream (e.g. "opus", "flac"). */
  audioCodec?: string;
  /** ffprobe `format_name` of the file (e.g. "matroska,webm", "ogg"). */
  formatName?: string;
  /** Channel count of the PRIMARY audio stream (1 = mono, 2 = stereo, …). */
  audioChannels?: number;
  /**
   * ffprobe stream index of the primary audio / video stream: the stream the
   * preview decodes (see `primaryStreamIndex`). Proxy generation and the
   * export mix map exactly these (Review M6).
   */
  primaryAudioStreamIndex?: number;
  primaryVideoStreamIndex?: number;
  /**
   * The file's start on ffmpeg's timeline (`format.start_time`), in seconds:
   * source time 0 everywhere in libi. The ffmpeg CLI rebases every input by
   * it, so `-ss` and the export mix's `atrim` already count from here; the
   * preview reads it through `/api/files/by-id/<id>/timing`. Non-zero for a
   * file cut from a stream, and for gapless audio whose encoder delay ffmpeg
   * skips but mediabunny doesn't: an MP3's LAME header (0.025 s), an Apple
   * AAC file's iTunSMPB (2112 samples). Absent when ffprobe reports none (WAV).
   */
  startTime?: number;
  /**
   * Matroska only: the primary audio track's CodecDelay, in seconds. ffmpeg
   * subtracts it from the track's timestamps, mediabunny doesn't, so the
   * preview shifts that track by it (lib/engine/source-time-origin.ts).
   * Absent for every other container and when the track has none.
   */
  audioCodecDelay?: number;
  /**
   * Matroska only: the primary audio track's encoder priming as ffmpeg skips
   * it, exact (ffprobe's `initial_padding` over the sample rate), where
   * `audioCodecDelay` is in whole ms. ffmpeg stamps the first kept sample at
   * the first packet's time plus the whole-ms delay, so the packets truly
   * start the difference later than their whole-ms times say
   * (lib/audio/packet-grid.ts). Absent when there is none.
   */
  audioPadding?: number;
  /**
   * How long after the file's start (`startTime`) the primary video / audio
   * stream starts, in seconds: its `start_time` on ffmpeg's timeline, 0 when
   * it starts with the file (or before it: AAC priming). Non-zero when one
   * stream starts late: a subtitle or the other stream first, a recording
   * whose camera or microphone started late. The export keeps that lead
   * rather than letting a cut or a mix pull the stream forward
   * (lib/export/export-base.ts `baseCut`). Absent when ffprobe can't say.
   */
  videoLead?: number;
  audioLead?: number;
  /**
   * The primary audio stream's `start_time` minus the file's, unclamped: the
   * time of its first decoded sample (ffmpeg applies an Opus pre-skip or a
   * Matroska CodecDelay first) on the file's timeline. Negative when the
   * stream starts before the file does (an Ogg cut's pre-roll), where
   * `audioLead` says 0. The preview places Ogg and Opus runs by it
   * (lib/audio/ogg-timeline.ts, lib/audio/opus-seek.ts). Absent when ffprobe
   * can't say.
   */
  audioStart?: number;
  /**
   * How an ffmpeg command that reads ONLY this file's audio (an export mix
   * clip, a duck sidechain, the transcription extract) puts it on the file's
   * timeline: input options to add before `-i`, and seconds to add to the
   * audio's timestamps (`asetpts=PTS+round(x/TB)`) before `aresample=first_pts=0`.
   * Absent when nothing is needed, which is every ordinary file.
   * - MPEG-TS, MPEG-PS and Ogg: when only some streams are read, the ffmpeg
   *   CLI moves the input's start to the first of THOSE ("Correcting start
   *   time of Input"), so an audio track that starts after the video lost
   *   its lead: `ptsShift` = `audioLead`.
   * - FLAC in MP4/MOV behind an edit list (a `-c copy` cut): ffmpeg's edit
   *   list handling hands its FLAC parser the pre-roll packets it then
   *   discards, and the parser re-frames around them: the decode repeats
   *   and skips 85 ms frames (a cut drifted 20 → −236 ms over 3 s, ffmpeg 8.1
   *   and 9.0.1, review round 3, R3-M4). mediabunny decodes it right. Read with
   *   `-advanced_editlist 0` the frames are intact, and start where the edit
   *   list's media time is: `ptsShift` moves them back.
   */
  audioRead?: { inputArgs: string[]; ptsShift: number };
  /**
   * Ogg only: the primary audio stream's first packet time (ffmpeg's, from
   * the granule positions), in seconds from the file's start. mediabunny
   * counts an Ogg stream read from its start from 0 whatever its granules say
   * (lib/audio/ogg-timeline.ts); this is where that first packet really is,
   * and how long it is (a Vorbis first packet decodes to no audio).
   */
  oggFirstPacket?: number;
  oggFirstPacketDuration?: number;
  /**
   * True when the video stream carries an alpha channel — either directly in
   * its pixel format (yuva*, rgba, ...) or via the WebM `alpha_mode`
   * side-band tag (where ffprobe's pix_fmt lies as yuv420p). Drives the
   * "never proxy / never native-decode" alpha-preservation rules.
   */
  hasAlpha?: boolean;
  /** ffprobe `codec_name` of the video stream (e.g. "vp9", "h264"). */
  videoCodec?: string;
  /** ffprobe `pix_fmt` of the video stream (e.g. "yuv420p", "gbrp"). */
  pixFmt?: string;
  /**
   * Frames per second of the video stream: `avg_frame_rate`, else
   * `r_frame_rate`. Absent when ffprobe reports neither (e.g. "0/0").
   */
  frameRate?: number;
  /**
   * The video stream's colour tags, as ffprobe names them (`color_space` is
   * the YUV matrix: "bt709", "smpte170m", "bt470bg", ...). ABSENT when the
   * stream doesn't carry the tag — ffprobe's "unknown" is never returned.
   */
  colorSpace?: string;
  colorPrimaries?: string;
  colorTransfer?: string;
  colorRange?: string;
}

/** An ffprobe rational like "30000/1001" as a positive number, or undefined. */
function rate(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const [n, d] = v.split("/").map(Number);
  const r = d === undefined ? n : n / d;
  return Number.isFinite(r) && r > 0 ? r : undefined;
}

/** An ffprobe time field ("0.025057") as a finite number, or undefined ("N/A"). */
function seconds(v: unknown): number | undefined {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * A stream's start, exact: `start_pts` × `time_base`. ffprobe prints
 * `start_time` to 6 decimals, a third of a sample off at 48 kHz, which the
 * ffmpeg paths that pad a late stream by it (`asetpts`) turned into a whole
 * sample (review round 4: a late track in TS and Ogg, 1 sample early).
 * Falls back to `start_time` when either is missing.
 */
function exactStart(st: Record<string, unknown> | undefined): number | undefined {
  const pts = typeof st?.start_pts === "number" ? st.start_pts : Number(st?.start_pts);
  const m = typeof st?.time_base === "string" ? /^(\d+)\/(\d+)$/.exec(st.time_base) : null;
  if (Number.isInteger(pts) && m && Number(m[2]) > 0) return (pts * Number(m[1])) / Number(m[2]);
  return seconds(st?.start_time);
}

/**
 * `delay` seconds as ffmpeg's Matroska demuxer subtracts it: rounded to whole
 * ticks of the stream's time base (`av_rescale_q`, halves away from zero), so
 * 23.22 ms becomes 23 ms at Matroska's default 1 ms. Unrounded, the preview
 * sat up to 0.22 ms off ffmpeg on top of the container's own millisecond
 * timestamps. An unreadable time base leaves the delay as it is.
 */
function inStreamTicks(delay: number, timeBase: unknown): number {
  const m = typeof timeBase === "string" ? /^(\d+)\/(\d+)$/.exec(timeBase) : null;
  const num = m ? Number(m[1]) : 0;
  const den = m ? Number(m[2]) : 0;
  if (!(delay > 0) || !(num > 0) || !(den > 0)) return delay;
  return (Math.round((delay * den) / num) * num) / den;
}

/** An ffprobe colour field, or undefined when the stream leaves it unset. */
function colorTag(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" && v !== "unknown" && v !== "unspecified" ? v : undefined;
}

const exec = promisify(execFile);

interface ProbedStream {
  index?: number;
  codec_type?: string;
  disposition?: Record<string, number>;
}

/** Still-image codecs: a video track in one of these is cover art or a
 *  thumbnail, not the picture, unless it is the only video there is. */
const STILL_IMAGE_CODECS = new Set(["mjpeg", "png", "bmp", "gif", "tiff", "webp", "jpeg2000", "jpegls"]);

/**
 * The stream the preview decodes for `type`: the first stream of `type` flagged
 * default (MP4 tkhd "enabled", Matroska FlagDefault; ffprobe's
 * disposition.default), else the first of `type`. The preview applies the same
 * rule to mediabunny's tracks (`lib/engine/primary-track.ts`) rather than
 * taking mediabunny's own pick, which since 1.42 also ranks by a bitrate
 * ffprobe can't see.
 *
 * `unlisted` are streams the preview's demuxer doesn't list at all (a disabled
 * or compressed Matroska track, `matroska-tracks.ts`). They are passed over
 * like cover art, unless nothing else of the type exists; then the preview has
 * no such track, falls back to the proxy, and the proxy carries this pick.
 *
 * Cover art is never the video:
 * - an attached_pic stream is skipped;
 * - so is a still-image-codec track while a real video exists. ffmpeg's
 *   Matroska muxer stores cover art as a plain MJPEG/PNG track, with no flag
 *   left. mediabunny can't decode such a track (codec null), so the preview
 *   plays the proxy, and the proxy and the export must carry the real video
 *   (final review).
 *
 * ffmpeg's own automatic selection differs (most channels, or the first `a`
 * stream in a filter label), which is why callers map this index explicitly.
 */
export function primaryStreamIndex(
  streams: Array<ProbedStream & { codec_name?: unknown }>,
  type: "audio" | "video",
  unlisted: ReadonlySet<number> = new Set(),
): number | undefined {
  let ofType = streams.filter(
    (s) => s.codec_type === type && !(type === "video" && s.disposition?.attached_pic === 1),
  );
  const listed = ofType.filter((s) => typeof s.index !== "number" || !unlisted.has(s.index));
  if (listed.length > 0) ofType = listed;
  if (type === "video") {
    const moving = ofType.filter((s) => !STILL_IMAGE_CODECS.has(String(s.codec_name ?? "")));
    if (moving.length > 0) ofType = moving;
  }
  const pick = ofType.find((s) => s.disposition?.default === 1) ?? ofType[0];
  return typeof pick?.index === "number" ? pick.index : undefined;
}

/**
 * Hard cap on a single ffprobe run. probeMedia sits on the BOOT path (the
 * has_alpha backfill sweep awaits it serially per row, and the 720p regen
 * sweep is sequenced after that sweep), so one ffprobe hung on a stalled
 * network mount must not stall boot maintenance forever. On expiry Node
 * SIGKILLs the child and the exec rejects — caught below, so a timeout
 * surfaces as an ordinary probe failure (`{}`, "unknown"), which callers
 * already handle by skipping, never deleting. 15s is orders of magnitude
 * above a healthy local probe (~tens of ms).
 */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Why a probe produced nothing: ffprobe ran past `PROBE_TIMEOUT_MS` and was
 * killed, or it failed outright (missing file, unreadable, not media, no
 * ffprobe). Distinct from a SUCCESSFUL probe of a file that simply has no
 * video stream, which `probeMedia`'s `{}` cannot tell apart.
 */
export type ProbeFailure = "timeout" | "unreadable";
export type ProbeResult = { ok: true; media: ProbedMedia } | { ok: false; failure: ProbeFailure };

/** Formats whose demuxer ffmpeg flags AVFMT_TS_DISCONT: the CLI corrects their start time. */
const START_CORRECTED_FORMATS = /(^|,)(mpegts|mpeg|ogg)(,|$)/;

/** See `ProbedMedia.audioRead`. */
async function audioReadFix(
  filePath: string,
  formatName: string,
  audio: Record<string, unknown> | undefined,
  startTime: number | undefined,
  audioLead: number | undefined,
): Promise<ProbedMedia["audioRead"]> {
  if (!audio) return undefined;
  const inputArgs: string[] = [];
  let ptsShift = 0;
  if (START_CORRECTED_FORMATS.test(formatName) && audioLead !== undefined && audioLead > 0.0005) ptsShift += audioLead;
  if (/(^|,)(mov|mp4)(,|$)/.test(formatName) && audio.codec_name === "flac" && startTime !== undefined) {
    try {
      const { stdout } = await exec(
        resolveFfprobePath(),
        ["-v", "quiet", "-advanced_editlist", "0", "-show_entries", "format=start_time", "-of", "csv=p=0", filePath],
        { timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL", windowsHide: true },
      );
      const plain = seconds(stdout.trim());
      if (plain !== undefined && Math.abs(plain - startTime) > 0.0001) {
        inputArgs.push("-advanced_editlist", "0");
        ptsShift += plain - startTime;
      }
    } catch {
      // Unknown: read it as before.
    }
  }
  return inputArgs.length > 0 || ptsShift !== 0 ? { inputArgs, ptsShift } : undefined;
}

/**
 * The first packet of stream `index`: its time and duration, exact in the
 * stream's `timeBase` when given (pts × time base; ffprobe prints times to 6
 * decimals), or undefined.
 */
async function firstPacket(filePath: string, index: number, timeBase?: unknown): Promise<{ time: number; duration: number } | undefined> {
  try {
    const { stdout } = await exec(
      resolveFfprobePath(),
      ["-v", "quiet", "-select_streams", String(index), "-read_intervals", "%+#1", "-show_entries", "packet=pts,duration,pts_time,duration_time", "-of", "json", filePath],
      { timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL", windowsHide: true },
    );
    const p = (JSON.parse(stdout) as { packets?: Array<Record<string, unknown>> }).packets?.[0];
    if (!p) return undefined;
    const m = typeof timeBase === "string" ? /^(\d+)\/(\d+)$/.exec(timeBase) : null;
    const tb = m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : null;
    const exact = (ticks: unknown) => (tb !== null && Number.isInteger(ticks) ? (ticks as number) * tb : undefined);
    const time = exact(p.pts) ?? seconds(p.pts_time);
    return time === undefined ? undefined : { time, duration: exact(p.duration) ?? seconds(p.duration_time) ?? 0 };
  } catch {
    return undefined;
  }
}

/**
 * Opus in Matroska: every packet that carries a DiscardPadding, as
 * `[seconds after the stream's first packet, samples at 48 kHz]`. ffmpeg
 * drops those samples from the end of that packet's decode; WebCodecs has no
 * way to be told, so the preview trims them itself (lib/audio/opus-seek.ts).
 * A packet in the middle of a stream carries one where two encodes were
 * joined (`ffmpeg -f concat -c copy`): the first one's last frame is cut
 * short, and everything after moves up by what it lost (53.5 ms for a 60 ms
 * frame, review round 4). The last packet's is the stream's end trim.
 *
 * Reads every packet header of the file (no decode): 0.15 s for a
 * 30-minute Opus WebM. The timing route calls it for Matroska Opus only, and
 * caches the answer; nothing else pays for it. Empty when there are none, or
 * ffprobe can't say.
 */
export async function readOpusDiscards(filePath: string, streamIndex: number): Promise<Array<[number, number]>> {
  try {
    const { stdout } = await exec(
      resolveFfprobePath(),
      ["-v", "quiet", "-select_streams", String(streamIndex), "-show_entries", "packet=pts_time:packet_side_data=discard_padding", "-of", "csv=p=0", filePath],
      { timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 256 * 1024 * 1024 },
    );
    const out: Array<[number, number]> = [];
    let first: number | undefined;
    for (const line of stdout.split("\n")) {
      const [time, discard] = line.trim().split(",").map((v) => seconds(v));
      if (time === undefined) continue;
      first ??= time;
      if (discard !== undefined && discard > 0) out.push([+(time - first).toFixed(6), discard]);
    }
    return out;
  } catch {
    return [];
  }
}

/** `probeMedia`, for a caller that must say WHY there is nothing to report. */
export async function probeMediaResult(filePath: string): Promise<ProbeResult> {
  try {
    const { stdout } = await exec(
      resolveFfprobePath(),
      [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        filePath,
      ],
      { timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL", windowsHide: true },
    );
    const data = JSON.parse(stdout);
    const streams: Array<ProbedStream & Record<string, unknown>> = Array.isArray(data.streams) ? data.streams : [];
    const formatName = typeof data.format?.format_name === "string" ? data.format.format_name : "";
    const mkvFlags = formatName.includes("matroska") ? await readMatroskaTrackFlags(filePath) : null;
    const unlisted = mkvFlags ? unlistedStreamIndexes(streams, mkvFlags) : new Set<number>();
    const primaryAudioStreamIndex = primaryStreamIndex(streams, "audio", unlisted);
    const primaryVideoStreamIndex = primaryStreamIndex(streams, "video", unlisted);
    // Describe the PRIMARY video stream, the one the preview decodes and the
    // export maps. size, codec, alpha (-> files.has_alpha and the proxy
    // gating) and colour must describe what is played, not merely the first
    // video stream. A file whose only picture is cover art still reports it,
    // as before.
    const videoStream =
      streams.find((s) => s.index === primaryVideoStreamIndex) ??
      streams.find((s) => s.codec_type === "video");
    const audioStream = streams.find((s) => s.codec_type === "audio");
    const duration = data.format?.duration
      ? parseFloat(data.format.duration)
      : undefined;
    const width = videoStream?.width as number | undefined;
    const height = videoStream?.height as number | undefined;
    const hasAudio = audioStream !== undefined;
    const primaryAudio = streams.find((s) => s.index === primaryAudioStreamIndex) ?? audioStream;
    const audioChannels =
      typeof primaryAudio?.channels === "number" && primaryAudio.channels > 0
        ? (primaryAudio.channels as number)
        : undefined;
    const hasAlpha =
      videoStream !== undefined ? streamHasAlpha(videoStream as Parameters<typeof streamHasAlpha>[0]) : undefined;
    const videoCodec = videoStream?.codec_name as string | undefined;
    // The file's start is its earliest stream's: exact from that stream.
    const printedStart = seconds(data.format?.start_time);
    const startTime =
      printedStart === undefined
        ? undefined
        : (streams.map((st) => exactStart(st)).find((t) => t !== undefined && Math.abs(t - printedStart) < 1.5e-6) ?? printedStart);
    const audioCodecDelay =
      mkvFlags && primaryAudioStreamIndex !== undefined
        ? inStreamTicks(codecDelayOfStream(streams, mkvFlags, primaryAudioStreamIndex), primaryAudio?.time_base)
        : 0;
    const padding = Number(primaryAudio?.initial_padding);
    const rateOfAudio = Number(primaryAudio?.sample_rate);
    const audioPadding = audioCodecDelay > 0 && padding > 0 && rateOfAudio > 0 ? padding / rateOfAudio : 0;
    const startOf = (st: Record<string, unknown> | undefined): number | undefined => {
      const at = exactStart(st);
      return at === undefined || startTime === undefined ? undefined : at - startTime;
    };
    const leadOf = (st: Record<string, unknown> | undefined): number | undefined => {
      const at = startOf(st);
      return at === undefined ? undefined : Math.max(0, at);
    };
    const videoLead = primaryVideoStreamIndex !== undefined ? leadOf(videoStream) : undefined;
    const audioLead = primaryAudio ? leadOf(primaryAudio) : undefined;
    const audioStart = primaryAudio ? startOf(primaryAudio) : undefined;
    const audioRead = await audioReadFix(filePath, formatName, primaryAudio, startTime, audioLead);
    const oggPacket = /(^|,)ogg(,|$)/.test(formatName) && primaryAudioStreamIndex !== undefined && startTime !== undefined
      ? await firstPacket(filePath, primaryAudioStreamIndex, primaryAudio?.time_base)
      : undefined;
    const oggFirstPacket = oggPacket && startTime !== undefined ? oggPacket.time - startTime : undefined;
    const pixFmt = videoStream?.pix_fmt as string | undefined;
    return {
      ok: true,
      media: {
        duration, width, height, hasAudio,
        ...(typeof primaryAudio?.codec_name === "string" ? { audioCodec: primaryAudio.codec_name } : {}),
        ...(formatName ? { formatName } : {}),
        ...(audioChannels !== undefined ? { audioChannels } : {}),
        ...(primaryAudioStreamIndex !== undefined ? { primaryAudioStreamIndex } : {}),
        ...(primaryVideoStreamIndex !== undefined ? { primaryVideoStreamIndex } : {}),
        ...(startTime !== undefined ? { startTime } : {}),
        ...(audioCodecDelay > 0 ? { audioCodecDelay } : {}),
        ...(audioPadding > 0 ? { audioPadding } : {}),
        ...(videoLead !== undefined ? { videoLead } : {}),
        ...(audioLead !== undefined ? { audioLead } : {}),
        ...(audioStart !== undefined ? { audioStart } : {}),
        ...(audioRead ? { audioRead } : {}),
        ...(oggFirstPacket !== undefined ? { oggFirstPacket, oggFirstPacketDuration: oggPacket?.duration ?? 0 } : {}),
        hasAlpha, videoCodec, pixFmt,
        frameRate: rate(videoStream?.avg_frame_rate) ?? rate(videoStream?.r_frame_rate),
        colorSpace: colorTag(videoStream?.color_space),
        colorPrimaries: colorTag(videoStream?.color_primaries),
        colorTransfer: colorTag(videoStream?.color_transfer),
        colorRange: colorTag(videoStream?.color_range),
      },
    };
  } catch (err) {
    // execFile's timeout kills the child and rejects with `killed: true`.
    const killed = typeof err === "object" && err !== null && (err as { killed?: unknown }).killed === true;
    return { ok: false, failure: killed ? "timeout" : "unreadable" };
  }
}

export async function probeMedia(filePath: string): Promise<ProbedMedia> {
  const r = await probeMediaResult(filePath);
  return r.ok ? r.media : {};
}

