import { z } from "zod/v3";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsAsync from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JobRunner, JobContext } from "@/lib/jobs/types";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";
import { assertPublicHttpUrl } from "@/lib/net/url-guard";
import { MAX_BYTES } from "@/lib/net/fetch-and-store";
import { resolveFfmpegPath } from "@/lib/ffmpeg/exec";
import { getLibiBinDir } from "@/lib/libi-home";
import { isWindows } from "@/lib/platform";
import { resolveNodeCommand } from "@/lib/runtime/node-runtime";
import { DependencyManager } from "@/mcp/registry/dependency-manager";
import { storeFile, mimeFromExtension } from "@/mcp/tools/file-tools";
import { serverLogger as logger } from "@/lib/logger";

/** The bundled extension def that carries the `uv` + `yt-dlp` deps — exact
 *  `mcp/registry/bundled.ts` strings. */
const YT_DLP_EXTENSION_ID = "youtube-download";
const UV_DEP_BINARY = "uv";
const YT_DLP_DEP_BINARY = "yt-dlp";

/** How long a cancelled child gets to honour SIGTERM before SIGKILL. yt-dlp
 *  normally exits on SIGTERM within milliseconds; the escalation exists for a
 *  child wedged in a blocking read (or a wrapper that swallowed the signal),
 *  which would otherwise keep the job in `cancel-requested` until the stream
 *  ended on its own. Exported for the test's timing assertion. */
export const SIGKILL_AFTER_MS = 5_000;

/** How often an UNKNOWN-size stream's progress lines are forwarded to the job.
 *  Matches JobManager's own debounce — these ticks carry no percentage, so
 *  their only job is to keep `lastProgressAt` fresh for the watchdog. */
export const UNKNOWN_SIZE_REPORT_MS = 1_000;

/** `--max-filesize` in the syntax yt-dlp's option validation accepts. Derived
 *  from the remote_fetch cap so the two agent-facing download paths cannot
 *  drift. Bare `M`, not `MiB`: `validate_bytes` runs `parse_bytes` —
 *  `lookup_unit_table({'': 1, K: 1024, M: 1024², …}, s.upper(), strict=True)`
 *  — so the unit is 1024-based and NO `B`/`iB` suffix is allowed; `500MiB`
 *  fails with `invalid max filesize` (2026.07.04). The `parse_filesize`
 *  table with its `MiB`/`MB` spellings is a different parser, used for
 *  format filters, not for this option. */
const MAX_FILESIZE_ARG = `${MAX_BYTES / (1024 * 1024)}M`;

const videoDownloadParamsSchema = z.object({
  url: z.string(),
  pieceId: z.string().nullable(),
  audioOnly: z.boolean().default(false),
});

export type VideoDownloadParams = z.infer<typeof videoDownloadParamsSchema>;

export interface VideoDownloadResult {
  fileId: string;
  filename: string;
  title: string;
  bytes: number;
}

/** IEC unit multipliers exactly as yt-dlp's `format_bytes` prints them. */
const UNITS: Record<string, number> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
};
const UNIT_RE = "(B|KiB|MiB|GiB|TiB)";

/** `<pct>% of [~]<size><unit>` — the `total_bytes` / `total_bytes_estimate`
 *  templates, and the finished line's literal `100% of <size><unit>`. */
const PERCENT_OF_TOTAL_RE = new RegExp(`^\\[download\\]\\s+([\\d.]+)%\\s+of\\s+~?\\s*([\\d.]+)${UNIT_RE}\\b`);
/** `<size><unit> at <speed>` — the `downloaded_bytes` templates yt-dlp falls
 *  back to when neither a total nor an estimate is known (live streams, some
 *  HLS). The `%` in the other shapes keeps this from matching them. */
const BYTES_ONLY_RE = new RegExp(`^\\[download\\]\\s+([\\d.]+)${UNIT_RE}\\s+at\\s`);
/** Printed once per stream before its progress starts (`downloader/common.py`
 *  `report_destination`) — the boundary the baseline accounting keys on. The
 *  PATH is captured because the same stream can announce itself twice: a
 *  retried HTTP download re-runs `report_destination` for the file it is
 *  restarting, and folding the partial bytes into the baseline a second time
 *  would count them twice. */
const STREAM_BOUNDARY_RE = /^\[download\] Destination:\s+(.+?)\s*$/;

export interface YtDlpProgress {
  done: number;
  /** Null when yt-dlp printed a byte count without a total. */
  total: number | null;
}

function parseBytes(size: string, unit: string): number | null {
  const n = Number.parseFloat(size);
  const mult = UNITS[unit];
  if (!Number.isFinite(n) || !mult) return null;
  return Math.round(n * mult);
}

/**
 * Parse one `--newline` progress line into absolute bytes.
 *
 * The shapes are yt-dlp's `downloader/common.py` `report_progress` templates,
 * with variable whitespace (every byte string is right-padded to 10 chars):
 *   `[download]  12.3% of   45.67MiB at  1.20MiB/s ETA 00:33`   known total
 *   `[download]   0.0% of ~  10.00MiB at Unknown B/s ETA Unknown` estimate
 *   `[download] 100% of    4.00MiB in 00:00:03 at 1.33MiB/s`     finished
 *   `[download]    5.00MiB at   1.20MiB/s (00:04)`               no total
 * The percent forms report a PERCENT and a TOTAL, never a running count, so
 * `done` is derived. The no-total form yields `total: null`. Returns null for
 * every other line (`N/A%`, Destination, merger, extractor chatter) so the
 * caller can ignore them cheaply.
 */
export function parseYtDlpProgress(line: string): YtDlpProgress | null {
  const t = line.trim();
  const withTotal = PERCENT_OF_TOTAL_RE.exec(t);
  if (withTotal) {
    const pct = Number.parseFloat(withTotal[1]);
    const total = parseBytes(withTotal[2], withTotal[3]);
    if (!Number.isFinite(pct) || total === null) return null;
    return { done: Math.round((total * pct) / 100), total };
  }
  const bytesOnly = BYTES_ONLY_RE.exec(t);
  if (bytesOnly) {
    const done = parseBytes(bytesOnly[1], bytesOnly[2]);
    return done === null ? null : { done, total: null };
  }
  return null;
}

/**
 * The yt-dlp wrapper the `yt-dlp-uv` custom installer writes into
 * `~/.libi/bin` (`mcp/registry/installers.ts`). Windows gets a `.cmd` shim
 * because symlinks need admin there; every other platform gets an
 * extensionless shell wrapper. Resolved here rather than trusting PATH so a
 * user's own stale yt-dlp is never the one that runs.
 */
export function ytDlpBinaryPath(): string {
  return path.join(getLibiBinDir(), isWindows() ? "yt-dlp.cmd" : "yt-dlp");
}

export interface YtDlpSpawn {
  command: string;
  /** Undefined = inherit this process's env unchanged. */
  env?: NodeJS.ProcessEnv;
}

/**
 * What to hand `spawn` for yt-dlp.
 *
 * Unix: the wrapper itself — a shell script that exports the certifi
 * `SSL_CERT_FILE` and execs the real entry point, so signals and exit codes
 * pass straight through.
 *
 * Windows: the wrapper is a `.cmd` shim, and since the CVE-2024-27980 fix
 * (Node ≥ 20.12) `spawn` REFUSES a `.cmd`/`.bat` with `EINVAL` unless
 * `shell: true` — which `lib/agents/acp/agent-registry.ts` explains is not
 * the fix (it is what the CVE was about, and it breaks on any path with a
 * space). Same answer as there: read the shim libi itself wrote
 * (`dependency-manager.ts#installYtDlpViaUv`), and spawn its target
 * directly with the env the shim would have set. The shim's `--no-playlist`
 * guard is not reproduced because this runner always passes the flag.
 *
 * A shim that is not in the shape libi writes is an install problem, not
 * something to run through a shell — fail naming the fix.
 */
export function resolveYtDlpSpawn(
  readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf-8"),
): YtDlpSpawn {
  const wrapper = ytDlpBinaryPath();
  if (!isWindows()) return { command: wrapper };
  const text = readFile(wrapper);
  const target = /^\s*"([^"]+)"\s/m.exec(text)?.[1];
  if (!target) {
    throw new Error(
      `${wrapper} is not the yt-dlp shim libi writes (no quoted target); reinstall the Video download extension`,
    );
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const m of text.matchAll(/^set (SSL_CERT_FILE|REQUESTS_CA_BUNDLE)=(.*)$/gm)) {
    env[m[1]] = m[2].trim();
  }
  return { command: target, env };
}

/**
 * yt-dlp's YouTube extractor solves the player's JS challenge in a JavaScript
 * runtime; without one it warns that extraction is deprecated and drops
 * formats. Only deno is enabled by default, so libi's own node is enabled
 * explicitly (`--js-runtimes RUNTIME[:PATH]`, verified on 2026.07.04).
 * `resolveNodeCommand()` is the managed absolute path when it exists and
 * the bare name otherwise — in which case yt-dlp does its own PATH search.
 */
function jsRuntimeArgs(): string[] {
  const node = resolveNodeCommand();
  return ["--js-runtimes", path.isAbsolute(node) ? `node:${node}` : "node"];
}

/**
 * Where yt-dlp should find ffmpeg for the merge / audio-extract steps. The
 * spawn inherits this process's env only, and under `npx` nothing puts
 * `~/.libi/bin` on PATH (MCP children and the Electron shell get it; the Next
 * server does not) — so libi's own ffmpeg is invisible to yt-dlp unless it is
 * pointed at explicitly. The DIRECTORY is passed (yt-dlp accepts either) so
 * ffprobe, which sits next to it, is found the same way. When
 * `resolveFfmpegPath` fell back to the bare name there is no bundled binary
 * to point at; yt-dlp then does its own PATH search, same as before.
 */
function ffmpegLocationArgs(): string[] {
  const ffmpeg = resolveFfmpegPath();
  return path.isAbsolute(ffmpeg) ? ["--ffmpeg-location", path.dirname(ffmpeg)] : [];
}

async function rmQuiet(dir: string): Promise<void> {
  await fsAsync.rm(dir, { recursive: true, force: true });
}

/**
 * Turns yt-dlp's per-stream progress into one monotonic byte counter.
 *
 * yt-dlp downloads a merged format as SEPARATE streams (video, then audio),
 * each announced by a `Destination:` line and each counted 0→100 % against
 * its own total. Reported raw, the bar drops when the second stream starts
 * and the final total is the last stream's size. So finished streams are
 * folded into a baseline, and the report is `baseline + current` against
 * `baseline + currentTotal`. A stream without a known total reports total 0,
 * which is how the job API represents "unknown" (`JobManager` stamps `0/0` at
 * start, the ETA returns null for it, and the Settings table renders `—`) —
 * the point is that the tick still moves `lastProgressAt` so the 180 s
 * watchdog does not fire on a live download.
 */
export class StreamProgress {
  private baseline = 0;
  private streamDone = 0;
  private highWater = 0;
  private lastUnknownReportAt = 0;
  /** Destination of the stream currently being counted, so a RE-announcement
   *  of the same one is recognised as a restart rather than a new stream. */
  private currentDestination: string | null = null;

  constructor(
    private readonly report: (done: number, total: number) => void,
    private readonly now: () => number = Date.now,
  ) {}

  line(line: string): void {
    const boundary = STREAM_BOUNDARY_RE.exec(line.trim());
    if (boundary) {
      const destination = boundary[1]!;
      // Same destination as the stream in progress → yt-dlp is RESTARTING it
      // (an HTTP error, a `--retries` attempt), not moving on to the next
      // one. Its partial bytes are about to be re-downloaded from 0, so they
      // must not be folded into the baseline: doing so made a single retried
      // stream report up to twice its real size, and `highWater` then pinned
      // the bar at that inflated number for the rest of the job.
      if (destination !== this.currentDestination) {
        this.baseline += this.streamDone;
        this.currentDestination = destination;
      }
      this.streamDone = 0;
      return;
    }
    const p = parseYtDlpProgress(line);
    if (!p) return;
    this.streamDone = p.done;
    // Never report below what was already shown: an estimate that shrinks
    // mid-stream must not read as the download going backwards.
    this.highWater = Math.max(this.highWater, this.baseline + p.done);
    if (p.total === null) {
      // Unknown size. There is no percentage to move and no terminal tick to
      // recognise, so these lines exist only to keep `lastProgressAt` fresh for
      // the 180 s watchdog — one per second is plenty. `--newline` emits ~10/s,
      // and each one that gets through is a DB write plus an emit. (JobManager
      // debounces too; this keeps the churn out of the chain in the first place,
      // and the byte counter above still advances on every line.)
      const at = this.now();
      if (at - this.lastUnknownReportAt < UNKNOWN_SIZE_REPORT_MS) return;
      this.lastUnknownReportAt = at;
      this.report(this.highWater, 0);
      return;
    }
    this.report(this.highWater, this.baseline + p.total);
  }
}

/**
 * yt-dlp's WORK-IN-PROGRESS artifacts, none of which is a finished download.
 *
 *   `<name>.part`, `<name>.part-FragNNN`  an in-flight (or abandoned) stream
 *   `<name>.ytdl`                          resume metadata
 *   `<name>.temp`                          a post-processor's scratch file
 *   `<name>.fNNN.<ext>`                    ONE stream of a `bv*+ba` pair
 *
 * The last one needs saying: after a successful merge yt-dlp deletes the
 * per-format files and leaves only the muxed output, so a surviving `.fNNN.`
 * file means the merge never ran — a video-only or audio-only stream wearing
 * a normal extension. The pattern is anchored at the very end of the name so
 * a title that merely CONTAINS something like `.f401.` is untouched.
 *
 * Why this exists: `--max-filesize` bounds each STREAM, and hitting it is not
 * an error to yt-dlp — it stops that stream, skips the merge, and exits 0,
 * leaving `<title>.f401.mp4.part` behind. The chooser below used to take the
 * LARGEST entry in the directory, which in that case IS the abandoned part
 * file, and libi then stored it and told the user the download had worked.
 * Measured on Big Buck Bunny 4K60: a 520,915,645-byte
 * `…f401.mp4.part` registered as an asset, `ffprobe` showing one AV1 video
 * stream and NO audio, job `completed 100%`.
 */
export function isPartialArtifact(name: string): boolean {
  return (
    /\.part(-Frag\d+)?$/.test(name) ||
    /\.ytdl$/.test(name) ||
    /\.temp$/.test(name) ||
    /\.f\d+\.[A-Za-z0-9]+$/.test(name)
  );
}

async function download(
  ctx: JobContext<VideoDownloadParams>,
  outDir: string,
): Promise<VideoDownloadResult> {
  const { url, pieceId, audioOnly } = ctx.params;
  const args = [
    "--newline",
    // A user's ~/.config/yt-dlp/config could otherwise add `--paths` / `-o`
    // and move the output out of the temp dir this runner owns and deletes.
    "--ignore-config",
    "--no-playlist",
    "--restrict-filenames",
    "--max-filesize",
    MAX_FILESIZE_ARG,
    ...ffmpegLocationArgs(),
    ...jsRuntimeArgs(),
    "-o",
    path.join(outDir, "%(title).150s.%(ext)s"),
    ...(audioOnly
      ? ["-f", "bestaudio", "-x", "--audio-format", "mp3"]
      : ["-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b", "--merge-output-format", "mp4"]),
    url,
  ];

  const ytDlp = resolveYtDlpSpawn();
  const child = spawn(ytDlp.command, args, { windowsHide: true, env: ytDlp.env });
  let stderr = "";
  // yt-dlp reports a `--max-filesize` refusal on STDOUT and exits non-zero
  // with nothing useful on stderr, so keep that line for the error message.
  let capNotice = "";
  const progress = new StreamProgress((done, total) => ctx.reportProgress(done, total, "bytes"));

  let buffered = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (/max-filesize/i.test(line)) capNotice = line.trim();
      progress.line(line);
    }
  });
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => {
    // Cap so a pathological failure cannot balloon the job row.
    if (stderr.length < 8192) stderr += chunk;
  });

  // Cancellation: SIGTERM on the first poll that sees the flag, SIGKILL if
  // the child is still open SIGKILL_AFTER_MS later. Both timers are cleared
  // in the `finally`, which runs whether the child closed, failed to spawn
  // (`error` → reject), or was killed.
  let termSent = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelTimer = setInterval(() => {
    if (termSent || !ctx.shouldCancel()) return;
    termSent = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      logger.warn(
        { tag: "video-download", op: "cancel_sigkill", pid: child.pid, afterMs: SIGKILL_AFTER_MS },
        "yt-dlp ignored SIGTERM; sending SIGKILL",
      );
      child.kill("SIGKILL");
    }, SIGKILL_AFTER_MS);
  }, 500);

  let code: number;
  try {
    code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (c) => resolve(c ?? 1));
    });
  } finally {
    clearInterval(cancelTimer);
    if (killTimer) clearTimeout(killTimer);
  }

  if (ctx.shouldCancel()) throw new Error("cancelled");
  if (code !== 0) {
    logger.warn(
      { tag: "video-download", op: "ytdlp_failed", code, stderr: stderr.slice(0, 2000), capNotice },
      "yt-dlp exited non-zero",
    );
    const tail = stderr.trim().split("\n").slice(-3).join(" ");
    throw new Error(`yt-dlp failed (exit ${code}): ${tail || capNotice || "no output"}`);
  }

  const entries = await fsAsync.readdir(outDir);
  if (entries.length === 0) {
    throw new Error(
      capNotice
        ? `yt-dlp refused the download: ${capNotice}`
        : "yt-dlp reported success but produced no file",
    );
  }
  // A run that could not produce a finished file must FAIL, not register
  // whatever is lying in the temp dir. See `isPartialArtifact`.
  const complete = entries.filter((e) => !isPartialArtifact(e));
  if (complete.length === 0) {
    logger.warn(
      { tag: "video-download", op: "no_complete_output", entries, capNotice },
      "yt-dlp exited 0 but left only unfinished output",
    );
    throw new Error(
      `yt-dlp produced no complete file — only unfinished output (${entries.sort().join(", ")}). ` +
        (capNotice
          ? `It stopped at libi's ${MAX_FILESIZE_ARG}iB per-stream download cap: ${capNotice}. ` +
            `This video is too large to import; try a lower-resolution source, or audioOnly if you only need the sound. `
          : "The streams were never merged, so there is no playable file. ") +
        "Nothing was imported.",
    );
  }
  // `--no-playlist` guarantees one media file; pick the largest of what is
  // actually finished.
  const stats = await Promise.all(
    complete.map(async (e) => ({ name: e, size: (await fsAsync.stat(path.join(outDir, e))).size })),
  );
  stats.sort((a, b) => b.size - a.size);
  const chosen = stats[0];
  // `--max-filesize` bounds each STREAM yt-dlp fetches; the merged output can
  // exceed it, and `storeFile` takes a Buffer, so the cap is enforced again
  // on the file that would actually be read into memory.
  if (chosen.size > MAX_BYTES) {
    throw new Error(`downloaded file too large: ${chosen.size} bytes (max ${MAX_BYTES})`);
  }
  const buffer = await fsAsync.readFile(path.join(outDir, chosen.name));

  // Registered as an asset the same way every other file-producing path does
  // — `storeFile` writes storage, ffprobes video/audio for duration and
  // dimensions, and inserts the `files` row.
  const record = await storeFile({
    pieceId,
    filename: chosen.name,
    buffer,
    contentType: mimeFromExtension(chosen.name),
    description: `Downloaded from ${url}`,
  });

  // The terminal row is the stored file's real size — for a merged download
  // that is larger than any single stream's total.
  ctx.reportProgress(buffer.length, buffer.length, "bytes");

  logger.info(
    { tag: "video-download", op: "stored", fileId: record.id, bytes: buffer.length, pieceId },
    "downloaded video stored as an asset",
  );

  return {
    fileId: record.id,
    filename: record.filename,
    title: path.basename(chosen.name, path.extname(chosen.name)),
    bytes: buffer.length,
  };
}

export const videoDownloadRunner: JobRunner<VideoDownloadParams, VideoDownloadResult> = {
  kind: "video_download",
  maxConcurrent: 2,
  paramsSchema: videoDownloadParamsSchema as unknown as z.ZodSchema<VideoDownloadParams>,
  resumable: false,
  noProgressTimeoutMs: 180_000,
  mcpToolId: makeMcpToolId("libi", "libi.download_video"),

  async run(ctx: JobContext<VideoDownloadParams>): Promise<VideoDownloadResult> {
    // Same SSRF guard every agent-supplied url goes through (remote_fetch).
    // Runs BEFORE any spawn so a file:// or metadata-service url never reaches
    // a subprocess.
    //
    // MUST be awaited. `assertPublicHttpUrl` is `async`
    // (lib/net/url-guard.ts:129, `Promise<VettedUrl>`) — it does a DNS lookup
    // and rejects on a private answer. Calling it bare makes the guard a
    // no-op: the rejection becomes an unhandled promise and yt-dlp spawns on
    // the unvetted url anyway. `lib/jobs/runners/remote-fetch.ts` awaits it;
    // do the same here.
    //
    // For a SUBPROCESS downloader the check is advisory, not a boundary:
    // remote_fetch pins its fetch to the vetted address via the returned
    // dispatcher, but yt-dlp resolves DNS and follows redirects on its own,
    // so a public hostname that later resolves or redirects to a private
    // address is not caught here. It still blocks the cheap cases (non-http
    // schemes, literal private/metadata addresses, hostnames that resolve
    // privately at check time) before anything is spawned.
    await assertPublicHttpUrl(ctx.params.url);

    // uv and yt-dlp are tier-2 deps: nothing installs them at boot, so a
    // fresh machine reaches this runner with an empty `~/.libi/bin`. `ensureDep`
    // (never `retryDep`) is a no-op once the dep is on disk with a matching
    // token, so an installed machine pays nothing here. uv first: yt-dlp's
    // custom installer shells out to it.
    const dm = new DependencyManager();
    for (const binary of [UV_DEP_BINARY, YT_DLP_DEP_BINARY]) {
      try {
        await dm.ensureDep(YT_DLP_EXTENSION_ID, binary);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Installing ${binary} (needed to download videos) failed: ${msg}`, {
          cause: err,
        });
      }
    }

    // One temp dir per run, removed in `finally` whatever happens after this
    // line — spawn error, non-zero exit, cancel, cap, or a `storeFile` throw.
    const outDir = await fsAsync.mkdtemp(path.join(os.tmpdir(), "libi-ytdlp-"));
    try {
      return await download(ctx, outDir);
    } finally {
      await rmQuiet(outDir);
    }
  },
};
