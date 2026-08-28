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

export interface ProbedMedia {
  duration?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  /**
   * True when the video stream carries an alpha channel — either directly in
   * its pixel format (yuva*, rgba, ...) or via the WebM `alpha_mode`
   * side-band tag (where ffprobe's pix_fmt lies as yuv420p). Drives the
   * "never proxy / never native-decode" alpha-preservation rules.
   */
  hasAlpha?: boolean;
  /** ffprobe `codec_name` of the video stream (e.g. "vp9", "h264"). */
  videoCodec?: string;
}

const exec = promisify(execFile);

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

export async function probeMedia(filePath: string): Promise<ProbedMedia> {
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
    const videoStream = data.streams?.find(
      (s: { codec_type: string }) => s.codec_type === "video",
    );
    const audioStream = data.streams?.find(
      (s: { codec_type: string }) => s.codec_type === "audio",
    );
    const duration = data.format?.duration
      ? parseFloat(data.format.duration)
      : undefined;
    const width = videoStream?.width as number | undefined;
    const height = videoStream?.height as number | undefined;
    const hasAudio = audioStream !== undefined;
    const hasAlpha =
      videoStream !== undefined ? streamHasAlpha(videoStream) : undefined;
    const videoCodec = videoStream?.codec_name as string | undefined;
    return { duration, width, height, hasAudio, hasAlpha, videoCodec };
  } catch {
    return {};
  }
}
