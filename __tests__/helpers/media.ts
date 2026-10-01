import { execFile, execFileSync } from "child_process";
import { resolveFfmpegPath, resolveFfprobePath } from "@/lib/ffmpeg/exec";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

const execFileAsync = promisify(execFile);

export interface MediaProbe {
  duration: number | null;
  format: string | null;
  videoStream: { codec: string; width: number; height: number; fps: number } | null;
  audioStream: { codec: string; sampleRate: number; channels: number } | null;
}

interface FfprobeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
}

interface FfprobeOutput {
  format?: { duration?: string; format_name?: string };
  streams?: FfprobeStream[];
}

export async function probe(filePath: string): Promise<MediaProbe> {
  const { stdout } = await execFileAsync(
    resolveFfprobePath(),
    ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
    { timeout: 10_000 },
  );
  const j = JSON.parse(stdout) as FfprobeOutput;
  const v = j.streams?.find((s) => s.codec_type === "video");
  const a = j.streams?.find((s) => s.codec_type === "audio");
  return {
    duration: j.format?.duration ? parseFloat(j.format.duration) : null,
    format: j.format?.format_name ?? null,
    videoStream:
      v && v.width != null && v.height != null
        ? {
            codec: v.codec_name,
            width: v.width,
            height: v.height,
            fps: evalRate(v.avg_frame_rate ?? "0/1"),
          }
        : null,
    audioStream:
      a && a.sample_rate != null && a.channels != null
        ? {
            codec: a.codec_name,
            sampleRate: parseInt(a.sample_rate, 10),
            channels: a.channels,
          }
        : null,
  };
}

function evalRate(s: string): number {
  const [n, d] = s.split("/").map(Number);
  return d ? n / d : n;
}

/**
 * Extract a single RGBA frame at the given time. Returns { rgba, width, height }.
 * Caller samples pixels by offset into the rgba buffer.
 * Throws if the file has no video stream or ffprobe fails.
 */
export async function extractFrameRgba(
  videoPath: string,
  timeSeconds: number,
): Promise<{ rgba: Buffer; width: number; height: number }> {
  const info = await probe(videoPath);
  if (!info.videoStream) throw new Error(`No video stream in ${videoPath}`);
  const { width, height } = info.videoStream;
  const { stdout } = await execFileAsync(
    resolveFfmpegPath(),
    [
      "-v", "error",
      "-ss", String(timeSeconds),
      "-i", videoPath,
      "-frames:v", "1",
      "-f", "rawvideo",
      "-pix_fmt", "rgba",
      "-",
    ],
    { timeout: 15_000, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  return { rgba: stdout as unknown as Buffer, width, height };
}

export function samplePixel(
  frame: { rgba: Buffer; width: number; height: number },
  x: number,
  y: number,
): [number, number, number, number] {
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
    throw new Error(`samplePixel out of bounds: (${x},${y}) in ${frame.width}x${frame.height}`);
  }
  const i = (y * frame.width + x) * 4;
  return [frame.rgba[i], frame.rgba[i + 1], frame.rgba[i + 2], frame.rgba[i + 3]];
}

/** Mean RGB across a rect — useful for "is this region close to red?" style asserts. */
export function sampleRegionMean(
  frame: { rgba: Buffer; width: number; height: number },
  rect: { x: number; y: number; w: number; h: number },
): [number, number, number] {
  if (
    rect.x < 0 || rect.y < 0 ||
    rect.w <= 0 || rect.h <= 0 ||
    rect.x + rect.w > frame.width ||
    rect.y + rect.h > frame.height
  ) {
    throw new Error(`sampleRegionMean out of bounds: ${JSON.stringify(rect)} in ${frame.width}x${frame.height}`);
  }
  let r = 0, g = 0, b = 0, n = 0;
  for (let yy = rect.y; yy < rect.y + rect.h; yy++) {
    for (let xx = rect.x; xx < rect.x + rect.w; xx++) {
      const i = (yy * frame.width + xx) * 4;
      r += frame.rgba[i]; g += frame.rgba[i + 1]; b += frame.rgba[i + 2]; n++;
    }
  }
  return [r / n, g / n, b / n];
}

/** Parses the `mean_volume` (dBFS) from ffmpeg's volumedetect filter. */
export async function audioMeanVolumeDb(filePath: string): Promise<number | null> {
  try {
    const { stderr } = await execFileAsync(
      resolveFfmpegPath(),
      ["-hide_banner", "-nostats", "-i", filePath, "-filter:a", "volumedetect", "-f", "null", "-"],
      { timeout: 20_000 },
    );
    const m = /mean_volume: *(-?\d+(?:\.\d+)?) dB/.exec(stderr);
    return m ? parseFloat(m[1]) : null;
  } catch {
    return null;
  }
}

export async function sha256(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const buf = await fs.promises.readFile(filePath);
  hash.update(buf);
  return hash.digest("hex");
}

export async function listTmpExportDirs(): Promise<string[]> {
  const entries = await fs.promises.readdir(os.tmpdir());
  return entries.filter((e) => e.startsWith("libi-export-")).map((e) => path.join(os.tmpdir(), e));
}

/**
 * Export scratch dirs that appeared since `before` — i.e. the ones the code
 * under test is actually responsible for.
 *
 * `listTmpExportDirs()` scans the SHARED OS tmpdir, so asserting it is empty
 * asserts something about the whole machine, not about this test. Any process
 * or earlier test file whose temp dir happens to start with `libi-export-`
 * fails it. That is not hypothetical: `export-render-runner.test.ts` names its
 * isolated homes `libi-export-runner-*`, which the prefix matches, so a run of
 * that file made the trim and caption leak assertions fail on the NEXT run —
 * an order-dependent flake that stayed hidden only because caption was skipped
 * and the survivors happened to be scheduled first.
 *
 * Snapshot before, diff after: the invariant each test means to pin.
 */
export async function newTmpExportDirsSince(before: string[]): Promise<string[]> {
  const seen = new Set(before);
  return (await listTmpExportDirs()).filter((d) => !seen.has(d));
}

/**
 * Skip guard for tests that shell out to REAL ffmpeg. Resolves the binary the
 * same way the code under test does — `resolveFfmpegPath()` checks
 * `<LIBI_HOME>/bin/ffmpeg` (Category A provisioning) before falling back to
 * PATH — so a dev whose only ffmpeg lives under `~/.libi/bin` is not falsely
 * skipped, and a machine with neither skips loudly instead of failing with
 * `spawn ffmpeg ENOENT` (which is what every ubuntu CI runner did until the
 * workflow started installing ffmpeg — see .github/workflows/test.yml).
 *
 * Consumers follow the fixture-guard pattern:
 *   if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
 *   describe.skipIf(!hasFfmpeg())(…)
 *
 * With `LIBI_REQUIRE_FFMPEG=1` (set by every CI gates job) a missing ffmpeg
 * THROWS instead of returning false. A skip is right on a bare dev clone and
 * wrong in CI: 0.1.16's release gates installed no ffmpeg, every real-ffmpeg
 * test skipped through this guard, and the gates went green over coverage they
 * never ran.
 */
let ffmpegPresent: boolean | null = null;
let ffmpegProbeFailure = "";

/**
 * The `ffmpeg -version` probe's bound. It was 2 s, which a loaded CI runner can
 * miss while paging in a ~100 MB static binary — and every consumer file
 * probes at collect time, in parallel. Harmless as a skip; as a failure under
 * LIBI_REQUIRE_FFMPEG it would send someone debugging the install instead of
 * the timeout. `LIBI_FFMPEG_PROBE_TIMEOUT_MS` overrides it (tests).
 */
function probeTimeoutMs(): number {
  const n = Number(process.env.LIBI_FFMPEG_PROBE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

/** Why the probe failed, in words that point at the right cause. */
function describeProbeFailure(err: unknown, bin: string, timeoutMs: number): string {
  const e = err as NodeJS.ErrnoException & { signal?: string | null; status?: number | null };
  if (e?.code === "ETIMEDOUT") {
    return `the probe \`${bin} -version\` TIMED OUT after ${timeoutMs} ms — ffmpeg was found but did not answer in time (a loaded machine?), so this is not a missing install`;
  }
  if (e?.code === "ENOENT") {
    return `ffmpeg was not found (resolved to "${bin}" via <LIBI_HOME>/bin, then PATH)`;
  }
  if (typeof e?.status === "number") {
    return `\`${bin} -version\` ran but exited with status ${e.status}`;
  }
  if (e?.signal) return `\`${bin} -version\` was killed by ${e.signal}`;
  return `\`${bin} -version\` failed: ${e?.message ?? String(err)}`;
}

export function hasFfmpeg(): boolean {
  if (ffmpegPresent === null) {
    const bin = resolveFfmpegPath();
    const timeoutMs = probeTimeoutMs();
    try {
      execFileSync(bin, ["-version"], { stdio: "ignore", timeout: timeoutMs });
      ffmpegPresent = true;
    } catch (err) {
      ffmpegPresent = false;
      ffmpegProbeFailure = describeProbeFailure(err, bin, timeoutMs);
    }
  }
  if (!ffmpegPresent && process.env.LIBI_REQUIRE_FFMPEG === "1") {
    throw new Error(
      `LIBI_REQUIRE_FFMPEG=1 but ${ffmpegProbeFailure}. This environment must run the ` +
        "real-ffmpeg tests, not skip them. In CI the gates job's setup-ffmpeg step " +
        "(.github/actions/setup-ffmpeg) installs ffmpeg into /usr/local/bin; read its log first.",
    );
  }
  return ffmpegPresent;
}

export const FFMPEG_SKIP_REASON =
  `ffmpeg unavailable (resolved to "${resolveFfmpegPath()}" via <LIBI_HOME>/bin, then PATH) — ` +
  "install it (brew install ffmpeg / apt-get install ffmpeg) or run libi once so " +
  "Category A provisioning fetches it";

/**
 * Does the resolved ffmpeg carry the `drawtext` filter? It is a build-time
 * option (libfreetype), not a runtime one, so two ffmpeg binaries on the same
 * machine can disagree — Homebrew's commonly lacks it while the one Category A
 * provisions into `<LIBI_HOME>/bin` has it. That disagreement is exactly why
 * the vitest global setup links the provisioned binaries into the isolated
 * home: probe and code under test must resolve the SAME binary, or these
 * tests skip over a filter the shipping product supports.
 */
let drawtextPresent: boolean | null = null;

export function hasDrawtext(): boolean {
  if (drawtextPresent !== null) return drawtextPresent;
  try {
    const out = execFileSync(resolveFfmpegPath(), ["-hide_banner", "-filters"], {
      timeout: 3000,
    }).toString();
    drawtextPresent = /\bdrawtext\b/.test(out);
  } catch {
    drawtextPresent = false;
  }
  return drawtextPresent;
}

export const DRAWTEXT_SKIP_REASON =
  `ffmpeg at "${resolveFfmpegPath()}" was built without the drawtext filter ` +
  "(needs libfreetype) — run libi once so Category A provisions a full build " +
  "into <LIBI_HOME>/bin, or install one with drawtext";

/**
 * Does the resolved ffmpeg's drawtext know `y_align` (ffmpeg ≥ 6.1)? The
 * export's drawtext spec places text with it, so a real-ffmpeg test of that
 * spec can only run where it exists.
 */
let yAlignPresent: boolean | null = null;

export function hasDrawtextYAlign(): boolean {
  if (yAlignPresent !== null) return yAlignPresent;
  try {
    const out = execFileSync(resolveFfmpegPath(), ["-hide_banner", "-h", "filter=drawtext"], {
      timeout: 3000,
    }).toString();
    yAlignPresent = /\by_align\b/.test(out);
  } catch {
    yAlignPresent = false;
  }
  return yAlignPresent;
}
