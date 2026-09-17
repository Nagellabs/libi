/**
 * `video_download` runner (lib/jobs/runners/video-download.ts).
 *
 * The pure parts (progress-line parsing, wrapper path, registration shape)
 * are pinned directly. The spawn path is driven end to end against a FAKE
 * `~/.libi/bin/yt-dlp` written into a per-test LIBI_HOME — a shell script
 * that prints real `--newline` progress lines and drops a file into the
 * `-o` directory — so the runner's wiring (guard → ensureDep → spawn → byte
 * progress → storeFile) is exercised without network, yt-dlp, or a DB.
 * DependencyManager and storeFile are mocked; everything else is real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsAsync from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Every DependencyManager call in the order the runner made it. */
let depCalls: string[] = [];
const ensureDep = vi.fn<(mcpId: string, binary: string) => Promise<void>>();
vi.mock("@/mcp/registry/dependency-manager", () => ({
  DependencyManager: class {
    ensureDep(mcpId: string, binary: string): Promise<void> {
      depCalls.push(`ensureDep:${mcpId}/${binary}`);
      return ensureDep(mcpId, binary);
    }
    retryDep(mcpId: string, binary: string): Promise<void> {
      depCalls.push(`retryDep:${mcpId}/${binary}`);
      return Promise.resolve();
    }
  },
}));

interface StoredArgs {
  pieceId: string | null;
  filename: string;
  buffer: Buffer;
  contentType: string | null;
  description?: string;
}
const storeFile = vi.fn<(a: StoredArgs) => Promise<{ id: string; filename: string }>>();
vi.mock("@/mcp/tools/file-tools", () => ({
  storeFile: (a: StoredArgs) => storeFile(a),
  mimeFromExtension: (f: string) =>
    f.endsWith(".mp4") ? "video/mp4" : f.endsWith(".mp3") ? "audio/mpeg" : null,
}));

import {
  parseYtDlpProgress,
  ytDlpBinaryPath,
  resolveYtDlpSpawn,
  videoDownloadRunner,
  SIGKILL_AFTER_MS,
  StreamProgress,
  UNKNOWN_SIZE_REPORT_MS,
  isPartialArtifact,
} from "@/lib/jobs/runners/video-download";
import { MAX_BYTES } from "@/lib/net/fetch-and-store";

/** The mkdtemp dir the runner handed the fake binary (via `-o`), so tests can
 *  assert it is gone afterwards whatever path the runner took. */
function recordedOutDir(): string {
  return fs.readFileSync(path.join(home, "outdir.txt"), "utf-8");
}

/** libi's bundled ffmpeg lives next to yt-dlp in `<LIBI_HOME>/bin`. */
function writeFakeFfmpeg(): string {
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "ffmpeg"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  return bin;
}

const savedHome = process.env.LIBI_HOME;
let home: string;

/**
 * Write a fake yt-dlp wrapper into `<home>/bin`. The script mirrors what the
 * real one prints under `--newline`: extractor chatter on stdout, then
 * progress lines, then (optionally) a file at the `-o` template's directory.
 * `-o` is the argument after the literal `-o`; the template's dirname is the
 * runner's mkdtemp dir, which the script cannot know in advance.
 */
function writeFakeYtDlp(body: string): void {
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const script =
    `#!/bin/bash\n` +
    `# Fake yt-dlp for tests. Finds the -o template so it can drop output next to it.\n` +
    `OUT=""\n` +
    `ARGS=("$@")\n` +
    `while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then OUT="$2"; shift; fi; shift; done\n` +
    `set -- "\${ARGS[@]}"\n` +
    `OUTDIR="$(dirname "$OUT")"\n` +
    `[ -n "$LIBI_TEST_YTDLP_OUTDIR" ] && printf '%s' "$OUTDIR" > "$LIBI_TEST_YTDLP_OUTDIR"\n` +
    body;
  fs.writeFileSync(path.join(bin, "yt-dlp"), script, { mode: 0o755 });
}

interface Reported {
  done: number;
  total: number;
  unit: string;
}

function makeCtx(
  params: { url: string; pieceId: string | null; audioOnly: boolean },
  reported: Reported[] = [],
  shouldCancel: () => boolean = () => false,
  onFirstProgress?: () => void,
) {
  return {
    jobId: "job-1",
    params,
    resumeState: null,
    reportProgress: (done: number, total: number, unit?: string) => {
      reported.push({ done, total, unit: unit ?? "" });
      if (reported.length === 1) onFirstProgress?.();
    },
    checkpoint: async () => {},
    shouldCancel,
  };
}

/**
 * The cancellation cases must not flip `shouldCancel` before the child is
 * actually running, so they wait for its first progress line. That wait used
 * to be `vi.waitFor(..., { timeout: 5_000 })` — a fixed budget for a REAL
 * `spawn` of a REAL shell script, which is the one thing in this file whose
 * cost is set by how busy the machine is, not by the code under test. It is
 * why this file flaked under full-suite load and passed standalone every time.
 * A promise resolved by the first `reportProgress` is the same wait
 * with no clock in it: it settles the instant the event happens, and if the
 * event never comes the test's own budget is what fails it.
 */
function firstProgressSignal(): { reported: Reported[]; started: Promise<void>; signal: () => void } {
  let signal: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    signal = resolve;
  });
  return { reported: [], started, signal };
}

// example.com resolves publicly, so the SSRF guard's DNS step passes. The fake
// binary never touches the network, so the hostname only has to be public.
const PUBLIC_URL = "https://example.com/watch?v=abc";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-ytdlp-test-"));
  process.env.LIBI_HOME = home;
  process.env.LIBI_TEST_YTDLP_OUTDIR = path.join(home, "outdir.txt");
  depCalls = [];
  ensureDep.mockReset();
  ensureDep.mockResolvedValue(undefined);
  storeFile.mockReset();
  storeFile.mockImplementation(async (a) => ({ id: "file-1", filename: a.filename }));
});

afterEach(() => {
  process.env.LIBI_HOME = savedHome;
  delete process.env.LIBI_TEST_YTDLP_OUTDIR;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("parseYtDlpProgress", () => {
  // Line shapes come from yt-dlp's downloader/common.py `report_progress`:
  // every byte string is `format_bytes` (`%.2f%sB`, IEC suffixes) right-padded
  // to 10 chars, percent is `%5.1f%%` or `  N/A%`, and the finished line is a
  // literal `100%` joined with whichever of `of`/`in`/`at` fields are known.
  it.each<[string, string, { done: number; total: number | null } | null]>([
    [
      "percent of a known total",
      "[download]  12.3% of   45.67MiB at  1.20MiB/s ETA 00:33",
      { done: 5890281, total: 47888466 },
    ],
    [
      "GiB total",
      "[download] 100.0% of    1.50GiB at 10.00MiB/s ETA 00:00",
      { done: 1610612736, total: 1610612736 },
    ],
    [
      "TiB total",
      "[download]   1.0% of    2.00TiB at 10.00MiB/s ETA 12:00:00",
      { done: 21990232556, total: 2199023255552 },
    ],
    [
      "KiB total",
      "[download]   0.5% of  512.00KiB at  Unknown B/s ETA Unknown",
      { done: 2621, total: 524288 },
    ],
    ["bare-byte total", "[download]  50.0% of  200.00B at  1.00KiB/s ETA 00:00", { done: 100, total: 200 }],
    [
      "the ~ prefix for an estimated size (total_bytes_estimate template)",
      "[download]   0.0% of ~  10.00MiB at Unknown B/s ETA Unknown",
      { done: 0, total: 10485760 },
    ],
    [
      "the finished line: `100% of X in Y at Z`",
      "[download] 100% of    4.00MiB in 00:00:03 at 1.33MiB/s",
      { done: 4194304, total: 4194304 },
    ],
    ["the finished line without a total carries no bytes", "[download] 100% in 00:00:03", null],
    [
      "unknown total (downloaded_bytes + elapsed template): bytes only, total null",
      "[download]    5.00MiB at   1.20MiB/s (00:04)",
      { done: 5242880, total: null },
    ],
    [
      "unknown total (downloaded_bytes template)",
      "[download]    5.00MiB at   1.20MiB/s",
      { done: 5242880, total: null },
    ],
    ["N/A% (the default template, no byte count at all)", "[download]   N/A% at  Unknown B/s ETA Unknown", null],
    ["the per-stream Destination line", "[download] Destination: /tmp/x/Title.f137.mp4", null],
    ["extractor chatter", "[youtube] abc123: Downloading webpage", null],
    ["a merger step", "[Merger] Merging formats into \"/tmp/x/Title.mp4\"", null],
    ["empty", "", null],
  ])("parses %s", (_name, line, expected) => {
    expect(parseYtDlpProgress(line)).toEqual(expected);
  });
});

/**
 * An unknown-size stream emits ~10 progress lines a second
 * and none of them carries a percentage, so forwarding every one of them was
 * pure churn — a DB write and an emit per line for the whole download. The
 * counter still has to advance on every line; only the REPORT is throttled.
 */
describe("StreamProgress — unknown-size throttle", () => {
  it("forwards at most one unknown-size tick per interval, and never loses bytes", () => {
    const reports: [number, number][] = [];
    let clock = 10_000;
    const sp = new StreamProgress((done, total) => reports.push([done, total]), () => clock);

    // 1 MiB per line, 100 ms apart — the real `--newline` cadence.
    for (let i = 1; i <= 10; i++) {
      sp.line(`[download]    ${i}.00MiB at   1.20MiB/s (00:0${i % 10})`);
      clock += 100;
    }
    // First line reports immediately; the next nine fall inside one interval.
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual([1024 * 1024, 0]);

    // Crossing the interval lets the CURRENT high-water through — not the
    // stale value from the line that was allowed.
    clock += UNKNOWN_SIZE_REPORT_MS;
    sp.line("[download]   11.00MiB at   1.20MiB/s (00:11)");
    expect(reports).toHaveLength(2);
    expect(reports[1]).toEqual([11 * 1024 * 1024, 0]);
  });

  it("does not throttle a KNOWN-size stream (the percentage has to move)", () => {
    const reports: [number, number][] = [];
    let clock = 10_000;
    const sp = new StreamProgress((done, total) => reports.push([done, total]), () => clock);
    for (const pct of [10, 20, 30, 40]) {
      sp.line(`[download]  ${pct}.0% of   10.00MiB at  1.20MiB/s ETA 00:33`);
      clock += 10;
    }
    expect(reports).toHaveLength(4);
    expect(reports.at(-1)).toEqual([Math.round(0.4 * 10 * 1024 * 1024), 10 * 1024 * 1024]);
  });
});

/**
 * The baseline is what makes a two-stream download read as one monotonic
 * counter: each `Destination:` line folds the finished stream's bytes into it
 * and the next stream counts from there. That is right when the line announces
 * a NEW stream — and wrong when it re-announces the one in progress, which is
 * what yt-dlp does when an HTTP download is restarted.
 */
describe("StreamProgress — a re-announced destination is a restart, not a new stream", () => {
  const reportsOf = () => {
    const reports: [number, number][] = [];
    return {
      reports,
      sp: new StreamProgress((done, total) => reports.push([done, total]), () => 0),
    };
  };

  it("does not fold a restarted stream's partial bytes into the baseline twice", () => {
    const { reports, sp } = reportsOf();
    sp.line("[download] Destination: /tmp/x/Clip.f137.mp4");
    sp.line("[download]  50.0% of    8.00B at  1.00KiB/s ETA 00:00");
    // The stream dies and yt-dlp restarts it: same file, counting from 0.
    sp.line("[download] Destination: /tmp/x/Clip.f137.mp4");
    sp.line("[download] 100% of    8.00B in 00:00:01 at 8.00B/s");

    // 8, not 12: the 4 partial bytes were re-downloaded, not added.
    expect(reports.at(-1)).toEqual([8, 8]);
    expect(reports.map(([, total]) => total)).toEqual([8, 8]);
  });

  it("never reports more than the streams' real combined size across a retry", () => {
    const { reports, sp } = reportsOf();
    sp.line("[download] Destination: /tmp/x/Clip.f137.mp4");
    sp.line("[download]  75.0% of    8.00B at  1.00KiB/s ETA 00:00");
    sp.line("[download] Destination: /tmp/x/Clip.f137.mp4");
    sp.line("[download] 100% of    8.00B in 00:00:01 at 8.00B/s");
    sp.line("[download] Destination: /tmp/x/Clip.f140.m4a");
    sp.line("[download] 100% of    4.00B in 00:00:01 at 4.00B/s");

    expect(reports.at(-1)).toEqual([12, 12]);
    for (const [done, total] of reports) expect(done).toBeLessThanOrEqual(total);
  });

  it("still folds the baseline when the destination genuinely changes", () => {
    const { reports, sp } = reportsOf();
    sp.line("[download] Destination: /tmp/x/Clip.f137.mp4");
    sp.line("[download] 100% of    8.00B in 00:00:01 at 8.00B/s");
    sp.line("[download] Destination: /tmp/x/Clip.f140.m4a");
    sp.line("[download]  50.0% of    4.00B at  1.00KiB/s ETA 00:00");
    expect(reports.at(-1)).toEqual([10, 12]);
  });

  it("tolerates the trailing whitespace yt-dlp pads its lines with", () => {
    const { reports, sp } = reportsOf();
    sp.line("[download] Destination: /tmp/x/Clip.f137.mp4  ");
    sp.line("[download]  50.0% of    8.00B at  1.00KiB/s ETA 00:00");
    sp.line("[download] Destination: /tmp/x/Clip.f137.mp4");
    sp.line("[download] 100% of    8.00B in 00:00:01 at 8.00B/s");
    expect(reports.at(-1)).toEqual([8, 8]);
  });
});

describe("ytDlpBinaryPath", () => {
  it("points at the wrapper the yt-dlp-uv installer writes into ~/.libi/bin", () => {
    const p = ytDlpBinaryPath();
    expect(path.dirname(p)).toBe(path.join(process.env.LIBI_HOME!, "bin"));
    expect(path.basename(p)).toMatch(/^yt-dlp(\.cmd)?$/);
  });
});

/** Stub `os.platform()`, NOT `process.platform`: `isWindows()` reads the
 *  former on purpose (Turbopack constant-folds the latter at build time). */
function pinPlatform(value: NodeJS.Platform): void {
  vi.spyOn(os, "platform").mockReturnValue(value);
}

describe("resolveYtDlpSpawn", () => {
  afterEach(() => vi.restoreAllMocks());

  it("spawns the shell wrapper itself off Windows, inheriting the env", () => {
    pinPlatform("darwin");
    expect(resolveYtDlpSpawn()).toEqual({ command: path.join(home, "bin", "yt-dlp") });
  });

  it("on Windows spawns the .cmd shim's target directly with the certifi env the shim would set", () => {
    // Since CVE-2024-27980 `spawn` refuses a .cmd without `shell: true`, so
    // the shim libi wrote (dependency-manager.ts#installYtDlpViaUv, verbatim
    // shape) is read instead of run.
    pinPlatform("win32");
    const exe = "C:\\Users\\First Last\\AppData\\Roaming\\uv\\tools\\yt-dlp\\Scripts\\yt-dlp.exe";
    const pem = "C:\\Users\\First Last\\AppData\\Roaming\\uv\\tools\\yt-dlp\\Lib\\site-packages\\certifi\\cacert.pem";
    const shim =
      "@echo off\r\n" +
      `set SSL_CERT_FILE=${pem}\r\nset REQUESTS_CA_BUNDLE=${pem}\r\n` +
      'echo %*| findstr /I /C:"playlist" >nul\r\n' +
      "if errorlevel 1 (\r\n" +
      `  "${exe}" --no-playlist %*\r\n` +
      ") else (\r\n" +
      `  "${exe}" %*\r\n` +
      ")\r\n";
    const readFile = vi.fn((p: string) => {
      expect(p).toBe(path.join(home, "bin", "yt-dlp.cmd"));
      return shim;
    });
    const r = resolveYtDlpSpawn(readFile);
    expect(r.command).toBe(exe);
    expect(r.env?.SSL_CERT_FILE).toBe(pem);
    expect(r.env?.REQUESTS_CA_BUNDLE).toBe(pem);
    // The rest of the process env still reaches yt-dlp (HOME, TEMP, proxies…).
    expect(r.env?.PATH).toBe(process.env.PATH);
  });

  it("on Windows leaves the cert vars alone when the shim has none", () => {
    pinPlatform("win32");
    const r = resolveYtDlpSpawn(() => '@echo off\r\n  "C:\\t\\yt-dlp.exe" --no-playlist %*\r\n');
    expect(r.command).toBe("C:\\t\\yt-dlp.exe");
    expect(r.env?.SSL_CERT_FILE).toBe(process.env.SSL_CERT_FILE);
  });

  it("on Windows refuses a shim that is not in the shape libi writes, naming the fix", () => {
    pinPlatform("win32");
    expect(() => resolveYtDlpSpawn(() => "@echo off\r\nyt-dlp %*\r\n")).toThrow(
      /yt-dlp\.cmd is not the yt-dlp shim libi writes.*reinstall the Video download extension/,
    );
  });
});

/**
 * `--max-filesize` bounds each STREAM, and exceeding it is not an error
 * to yt-dlp: it aborts that stream, skips the merge, and exits 0. What is left
 * in the temp dir is `<title>.f401.mp4.part` (plus, often, the small audio
 * stream that DID finish). The chooser took the largest entry, so libi stored
 * the abandoned part file and reported success — measured on Big Buck Bunny
 * 4K60 as a 520,915,645-byte `…f401.mp4.part` asset that `ffprobe` reads as
 * one AV1 video stream with no audio.
 */
describe("isPartialArtifact", () => {
  it("rejects every yt-dlp work-in-progress artifact", () => {
    for (const name of [
      "Big_Buck_Bunny.f401.mp4.part",
      "Big_Buck_Bunny.mp4.part",
      "Big_Buck_Bunny.mp4.part-Frag17",
      "Big_Buck_Bunny.mp4.ytdl",
      "Big_Buck_Bunny.mp4.temp",
      // A surviving per-format stream means the merge never ran — video-only
      // or audio-only, wearing an ordinary extension.
      "Big_Buck_Bunny.f401.mp4",
      "Big_Buck_Bunny.f140.m4a",
    ]) {
      expect(isPartialArtifact(name)).toBe(true);
    }
  });

  it("accepts a finished download", () => {
    for (const name of [
      "Big_Buck_Bunny.mp4",
      "Me_at_the_zoo.mp4",
      "Song.mp3",
      "Clip.webm",
      // The format-id pattern is anchored at the END, so a title that merely
      // contains one is untouched.
      "Talk_about_the.f401.codec_-_part_2.mp4",
    ]) {
      expect(isPartialArtifact(name)).toBe(false);
    }
  });
});

describe("videoDownloadRunner", () => {
  it("is registered under the video_download kind and declares its tool", () => {
    expect(videoDownloadRunner.kind).toBe("video_download");
    expect(videoDownloadRunner.mcpToolId).toBe("libi:libi.download_video");
    expect(videoDownloadRunner.maxConcurrent).toBe(2);
  });

  // `file:///etc/passwd` PARSES fine as a URL, so it never reaches the
  // `invalid url:` branch — it is rejected one branch later, by the scheme
  // check. Verified in lib/net/url-guard.ts:130-137:
  //   catch { throw new Error(`invalid url: ${raw}`); }          // unparseable only
  //   if (u.protocol !== "http:" && u.protocol !== "https:")
  //     throw new Error(`unsupported scheme: ${u.protocol}`);    // → "unsupported scheme: file:"
  // Matching /invalid url/i here would fail even with the `await` in place.
  it("rejects a non-http url before spawning anything", async () => {
    await expect(
      videoDownloadRunner.run(
        makeCtx({ url: "file:///etc/passwd", pieceId: null, audioOnly: false }) as never,
      ),
    ).rejects.toThrow(/unsupported scheme/i);
    expect(depCalls).toEqual([]);
  });

  // The `invalid url:` branch, proven separately with a genuinely unparseable
  // string — so a future refactor that drops the scheme check cannot make the
  // test above pass for the wrong reason.
  it("rejects an unparseable url", async () => {
    await expect(
      videoDownloadRunner.run(
        makeCtx({ url: "http://[not a url", pieceId: null, audioOnly: false }) as never,
      ),
    ).rejects.toThrow(/invalid url/i);
  });

  // The guard must be AWAITED, not merely called: an unawaited async guard
  // rejects into an unhandled promise while the spawn proceeds. This asserts
  // the failure surfaces as the job's own rejection.
  it("rejects a private address before spawning", async () => {
    await expect(
      videoDownloadRunner.run(
        makeCtx({
          url: "http://169.254.169.254/latest/meta-data/",
          pieceId: null,
          audioOnly: false,
        }) as never,
      ),
    ).rejects.toThrow(/blocked private address/i);
    expect(depCalls).toEqual([]);
  });

  it("ensures uv then yt-dlp (ensureDep, never retryDep) before spawning, reports byte progress from the --newline lines, and stores the file as an asset", async () => {
    writeFakeYtDlp(
      `echo "[youtube] abc: Downloading webpage"\n` +
        `echo "[download]  25.0% of   4.00MiB at  1.00MiB/s ETA 00:03"\n` +
        `echo "[download] 100.0% of   4.00MiB at  1.00MiB/s ETA 00:00"\n` +
        `printf 'video-bytes' > "$OUTDIR/Some_Title.mp4"\n` +
        `printf 'x' > "$OUTDIR/Some_Title.mp4.part"\n`,
    );
    const reported: Reported[] = [];
    const result = await videoDownloadRunner.run(
      makeCtx({ url: PUBLIC_URL, pieceId: "piece-9", audioOnly: false }, reported) as never,
    );

    expect(depCalls).toEqual([
      "ensureDep:youtube-download/uv",
      "ensureDep:youtube-download/yt-dlp",
    ]);
    expect(reported.map((r) => r.unit).every((u) => u === "bytes")).toBe(true);
    expect(reported).toContainEqual({ done: 1048576, total: 4194304, unit: "bytes" });
    expect(reported).toContainEqual({ done: 4194304, total: 4194304, unit: "bytes" });
    // No fake `(0, 100)` opener: JobManager already stamps `0/0` when the run
    // starts, and a 100-"byte" total would render as a real percentage.
    expect(reported.find((r) => r.total === 100)).toBeUndefined();
    // The terminal row is the STORED file's size, not the last stream's total.
    expect(reported.at(-1)).toEqual({
      done: "video-bytes".length,
      total: "video-bytes".length,
      unit: "bytes",
    });
    expect(fs.existsSync(recordedOutDir())).toBe(false);

    expect(storeFile).toHaveBeenCalledTimes(1);
    const stored = storeFile.mock.calls[0][0];
    // The largest entry wins — never the `.part` remnant.
    expect(stored.filename).toBe("Some_Title.mp4");
    expect(stored.buffer.toString()).toBe("video-bytes");
    expect(stored.contentType).toBe("video/mp4");
    expect(stored.pieceId).toBe("piece-9");
    expect(stored.description).toBe(`Downloaded from ${PUBLIC_URL}`);

    expect(result).toEqual({
      fileId: "file-1",
      filename: "Some_Title.mp4",
      title: "Some_Title",
      bytes: "video-bytes".length,
    });
  });

  /** Fail honestly rather than register the abandoned stream. */
  it("fails when yt-dlp exits 0 having left only unfinished output, and stores nothing", async () => {
    writeFakeYtDlp(
      `echo "[download] Destination: $OUTDIR/BBB.f401.mp4"\n` +
        `echo "[download]  73.1% of  680.00MiB at  4.00MiB/s ETA 00:45"\n` +
        `echo "[download] File is larger than max-filesize (531947029 bytes > 524288000 bytes). Aborting."\n` +
        `printf 'partial-video' > "$OUTDIR/BBB.f401.mp4.part"\n` +
        // The audio stream that DID finish is still only one half of a merge.
        `printf 'audio' > "$OUTDIR/BBB.f140.m4a"\n` +
        `exit 0\n`,
    );
    const reported: Reported[] = [];
    await expect(
      videoDownloadRunner.run(
        makeCtx({ url: PUBLIC_URL, pieceId: "piece-9", audioOnly: false }, reported) as never,
      ),
    ).rejects.toThrow(/no complete file/i);
    expect(storeFile).not.toHaveBeenCalled();
    // The message has to name the cause the user can act on.
    await expect(
      videoDownloadRunner.run(
        makeCtx({ url: PUBLIC_URL, pieceId: "piece-9", audioOnly: false }, []) as never,
      ),
    ).rejects.toThrow(/max-filesize|per-stream download cap/i);
    // And the temp dir is still cleaned up on the failing path.
    expect(fs.existsSync(recordedOutDir())).toBe(false);
  });

  it("passes the audio-only extraction flags when audioOnly is set", async () => {
    // The child inherits process.env, so the script can record its argv
    // somewhere OUTSIDE the runner's output dir.
    const argsFile = path.join(home, "args.txt");
    process.env.LIBI_TEST_YTDLP_ARGS = argsFile;
    const binDir = writeFakeFfmpeg();
    try {
      writeFakeYtDlp(
        `printf '%s\\n' "$@" > "$LIBI_TEST_YTDLP_ARGS"\n` +
          `printf 'mp3-bytes' > "$OUTDIR/Song.mp3"\n`,
      );
      const result = await videoDownloadRunner.run(
        makeCtx({ url: PUBLIC_URL, pieceId: null, audioOnly: true }, []) as never,
      );
      const args = fs.readFileSync(argsFile, "utf-8").trimEnd().split("\n");
      expect(args).toContain("-x");
      expect(args).toContain("--audio-format");
      expect(args).toContain("mp3");
      expect(args).toContain("--newline");
      expect(args).toContain("--no-playlist");
      expect(args).toContain("--restrict-filenames");
      expect(args[args.indexOf("-o") + 1]).toMatch(/%\(title\)\.150s\.%\(ext\)s$/);
      // A user's own yt-dlp config must not be able to move `-o`/`--paths`
      // out of the runner's temp dir.
      expect(args).toContain("--ignore-config");
      // Same cap as remote_fetch, derived from the same constant. Bare `M`:
      // `--max-filesize` is validated by yt-dlp's `parse_bytes` (K/M/G/T…,
      // 1024-based, NO B/iB suffix) — `500MiB` is rejected with
      // `invalid max filesize` (reproduced on 2026.07.04, live run).
      expect(args[args.indexOf("--max-filesize") + 1]).toBe(`${MAX_BYTES / 1024 / 1024}M`);
      // Under npx nothing puts ~/.libi/bin on PATH, so yt-dlp is told where
      // libi's ffmpeg lives (the directory — ffprobe is found there too).
      expect(args[args.indexOf("--ffmpeg-location") + 1]).toBe(binDir);
      // YouTube's JS challenge needs a runtime; only deno is on by default.
      // No managed node in this LIBI_HOME, so yt-dlp gets the bare name and
      // does its own PATH search.
      expect(args[args.indexOf("--js-runtimes") + 1]).toBe("node");
      expect(args.at(-1)).toBe(PUBLIC_URL);
      const stored = storeFile.mock.calls[0][0];
      expect(stored.filename).toBe("Song.mp3");
      expect(stored.contentType).toBe("audio/mpeg");
      expect(result).toMatchObject({ fileId: "file-1", filename: "Song.mp3", title: "Song" });
    } finally {
      delete process.env.LIBI_TEST_YTDLP_ARGS;
    }
  });

  it("enables libi's managed node as yt-dlp's JS runtime when it exists", async () => {
    const argsFile = path.join(home, "args.txt");
    process.env.LIBI_TEST_YTDLP_ARGS = argsFile;
    const bin = path.join(home, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const managedNode = path.join(bin, "node");
    fs.writeFileSync(managedNode, "#!/bin/bash\nexit 0\n", { mode: 0o755 });
    try {
      writeFakeYtDlp(
        `printf '%s\\n' "$@" > "$LIBI_TEST_YTDLP_ARGS"\n` + `printf 'v' > "$OUTDIR/T.mp4"\n`,
      );
      await videoDownloadRunner.run(
        makeCtx({ url: PUBLIC_URL, pieceId: null, audioOnly: false }) as never,
      );
      const args = fs.readFileSync(argsFile, "utf-8").trimEnd().split("\n");
      expect(args[args.indexOf("--js-runtimes") + 1]).toBe(`node:${managedNode}`);
    } finally {
      delete process.env.LIBI_TEST_YTDLP_ARGS;
    }
  });

  it("fails the job with the exit code and the stderr tail when yt-dlp exits non-zero, storing nothing", async () => {
    writeFakeYtDlp(`echo "ERROR: [youtube] abc: Video unavailable" >&2\nexit 1\n`);
    await expect(
      videoDownloadRunner.run(
        makeCtx({ url: PUBLIC_URL, pieceId: null, audioOnly: false }) as never,
      ),
    ).rejects.toThrow(/yt-dlp failed \(exit 1\): ERROR: \[youtube\] abc: Video unavailable/);
    expect(storeFile).not.toHaveBeenCalled();
  });

  it("fails when yt-dlp exits 0 without producing a file", async () => {
    writeFakeYtDlp(`echo "[download] 100.0% of 1.00MiB at 1.00MiB/s ETA 00:00"\n`);
    await expect(
      videoDownloadRunner.run(
        makeCtx({ url: PUBLIC_URL, pieceId: null, audioOnly: false }) as never,
      ),
    ).rejects.toThrow(/produced no file/i);
    expect(storeFile).not.toHaveBeenCalled();
  });

  it("fails the job naming the dependency when ensureDep rejects, and never spawns", async () => {
    let spawned = false;
    writeFakeYtDlp(`printf 'x' > "$OUTDIR/spawned.mp4"\n`);
    ensureDep.mockImplementation(async (_mcpId, binary) => {
      if (binary === "yt-dlp") throw new Error("uv tool install failed: boom");
    });
    storeFile.mockImplementation(async (a) => {
      spawned = true;
      return { id: "never", filename: a.filename };
    });
    await expect(
      videoDownloadRunner.run(
        makeCtx({ url: PUBLIC_URL, pieceId: null, audioOnly: false }) as never,
      ),
    ).rejects.toThrow(/yt-dlp.*uv tool install failed: boom/);
    expect(spawned).toBe(false);
    expect(depCalls).toEqual([
      "ensureDep:youtube-download/uv",
      "ensureDep:youtube-download/yt-dlp",
    ]);
  });

  it("SIGTERMs yt-dlp and rejects as cancelled when shouldCancel flips mid-download", async () => {
    // Sleeps well past the runner's 500ms cancel poll; a SIGTERM ends it early.
    // The background sleep gets no stdio of its own: an orphan holding the
    // stdout pipe would keep the child's `close` event from firing until it
    // exited on its own, which is the very hang the runner must not have.
    writeFakeYtDlp(
      `echo "[download]  10.0% of   4.00MiB at  1.00MiB/s ETA 00:03"\n` +
        `sleep 30 </dev/null >/dev/null 2>&1 &\nSLEEP=$!\n` +
        `trap 'kill $SLEEP 2>/dev/null; exit 143' TERM\n` +
        `wait $SLEEP\n` +
        `printf 'late' > "$OUTDIR/late.mp4"\n`,
    );
    let cancel = false;
    const { reported, started, signal } = firstProgressSignal();
    const run = videoDownloadRunner.run(
      makeCtx({ url: PUBLIC_URL, pieceId: null, audioOnly: false }, reported, () => cancel, signal) as never,
    );
    // Flip once the first progress tick proves the child is running.
    await started;
    cancel = true;
    // The SIGTERM is what ends it: the script's own `sleep 30` outlives this
    // test's budget several times over, so reaching this line at all is the
    // assertion the old `< 10_000` wall clock was making — without a clock
    // that a loaded machine can blow past.
    await expect(run).rejects.toThrow(/cancelled/);
    expect(storeFile).not.toHaveBeenCalled();
  }, 20_000);

  it("omits --ffmpeg-location when libi has no bundled ffmpeg, leaving yt-dlp to search PATH", async () => {
    const argsFile = path.join(home, "args.txt");
    process.env.LIBI_TEST_YTDLP_ARGS = argsFile;
    try {
      writeFakeYtDlp(
        `printf '%s\\n' "$@" > "$LIBI_TEST_YTDLP_ARGS"\n` + `printf 'v' > "$OUTDIR/T.mp4"\n`,
      );
      await videoDownloadRunner.run(
        makeCtx({ url: PUBLIC_URL, pieceId: null, audioOnly: false }, []) as never,
      );
      const args = fs.readFileSync(argsFile, "utf-8").trimEnd().split("\n");
      expect(args).not.toContain("--ffmpeg-location");
    } finally {
      delete process.env.LIBI_TEST_YTDLP_ARGS;
    }
  });

  it("fails without registering an asset when the output exceeds the byte cap, and removes the temp dir", async () => {
    // A sparse file: `stat` reports 600 MiB, the disk holds nothing, and the
    // runner must never read it into memory.
    //
    // The `storeFile`/`existsSync` assertions below hold either way —
    // a runner that read the 600 MiB in and THEN threw would pass both. The
    // whole point of the pre-read `stat` guard is that the read never
    // happens, so the read itself is what has to be observed. `readFile` is
    // spied rather than mocked so the failure path still runs for real.
    const readFile = vi.spyOn(fsAsync, "readFile");
    writeFakeYtDlp(
      `echo "[download] 100% of  600.00MiB in 00:01:00 at 10.00MiB/s"\n` +
        `dd if=/dev/null of="$OUTDIR/Huge.mp4" bs=1 seek=${MAX_BYTES + 100 * 1024 * 1024} count=0 2>/dev/null\n`,
    );
    try {
      await expect(
        videoDownloadRunner.run(
          makeCtx({ url: PUBLIC_URL, pieceId: null, audioOnly: false }) as never,
        ),
      ).rejects.toThrow(/too large/i);
      expect(
        readFile.mock.calls.map(([f]) => String(f)).filter((f) => f.includes("Huge.mp4")),
        "the over-cap file must never be read into memory — the cap exists to keep it out of the heap",
      ).toEqual([]);
    } finally {
      readFile.mockRestore();
    }
    expect(storeFile).not.toHaveBeenCalled();
    expect(fs.existsSync(recordedOutDir())).toBe(false);
  });

  it("DOES read the file when it is under the cap — the guard is the size, not a blanket refusal", async () => {
    // The paired direction: without it, a runner that never read anything at
    // all would satisfy the assertion above.
    const readFile = vi.spyOn(fsAsync, "readFile");
    writeFakeYtDlp(`printf 'v' > "$OUTDIR/Small.mp4"\n`);
    try {
      await videoDownloadRunner.run(
        makeCtx({ url: PUBLIC_URL, pieceId: null, audioOnly: false }) as never,
      );
      expect(
        readFile.mock.calls.map(([f]) => String(f)).filter((f) => f.includes("Small.mp4")),
      ).toHaveLength(1);
    } finally {
      readFile.mockRestore();
    }
    expect(storeFile).toHaveBeenCalled();
  });

  it("removes the temp dir when storeFile throws, and surfaces the throw", async () => {
    writeFakeYtDlp(`printf 'v' > "$OUTDIR/T.mp4"\n`);
    storeFile.mockRejectedValue(new Error("Piece not found: piece-x"));
    await expect(
      videoDownloadRunner.run(
        makeCtx({ url: PUBLIC_URL, pieceId: "piece-x", audioOnly: false }) as never,
      ),
    ).rejects.toThrow(/Piece not found/);
    expect(fs.existsSync(recordedOutDir())).toBe(false);
  });

  it("removes the temp dir when yt-dlp exits non-zero", async () => {
    writeFakeYtDlp(`echo "boom" >&2\nexit 2\n`);
    await expect(
      videoDownloadRunner.run(
        makeCtx({ url: PUBLIC_URL, pieceId: null, audioOnly: false }) as never,
      ),
    ).rejects.toThrow(/exit 2/);
    expect(fs.existsSync(recordedOutDir())).toBe(false);
  });

  it("reports monotonic progress across a two-stream (video + audio) download and ends on the merged file's size", async () => {
    // yt-dlp announces each stream with a Destination line, then counts that
    // stream 0→100 % against ITS OWN total. Without a baseline the bar would
    // drop from 8/8 back to 2/4 when the audio stream starts, and the final
    // total would be the audio stream's 4 bytes rather than the merged file.
    writeFakeYtDlp(
      `echo "[download] Destination: $OUTDIR/Clip.f137.mp4"\n` +
        `echo "[download]  50.0% of    8.00B at  1.00KiB/s ETA 00:00"\n` +
        `echo "[download] 100% of    8.00B in 00:00:01 at 8.00B/s"\n` +
        `echo "[download] Destination: $OUTDIR/Clip.f140.m4a"\n` +
        `echo "[download]  50.0% of    4.00B at  1.00KiB/s ETA 00:00"\n` +
        `echo "[download] 100% of    4.00B in 00:00:01 at 4.00B/s"\n` +
        `echo "[Merger] Merging formats into \\"$OUTDIR/Clip.mp4\\""\n` +
        `printf '%020d' 0 > "$OUTDIR/Clip.mp4"\n`,
    );
    const reported: Reported[] = [];
    await videoDownloadRunner.run(
      makeCtx({ url: PUBLIC_URL, pieceId: null, audioOnly: false }, reported) as never,
    );
    expect(reported).toEqual([
      { done: 4, total: 8, unit: "bytes" },
      { done: 8, total: 8, unit: "bytes" },
      { done: 10, total: 12, unit: "bytes" },
      { done: 12, total: 12, unit: "bytes" },
      { done: 20, total: 20, unit: "bytes" },
    ]);
    for (let i = 1; i < reported.length; i++) {
      expect(reported[i].done).toBeGreaterThanOrEqual(reported[i - 1].done);
      expect(reported[i].total).toBeGreaterThanOrEqual(reported[i - 1].total);
    }
  });

  it("reports bytes with an unknown (0) total for the size-less template so the watchdog sees activity", async () => {
    writeFakeYtDlp(
      `echo "[download]    5.00MiB at   1.20MiB/s (00:04)"\n` +
        `echo "[download]   10.00MiB at   1.20MiB/s (00:08)"\n` +
        `printf 'v' > "$OUTDIR/Live.mp4"\n`,
    );
    const reported: Reported[] = [];
    await videoDownloadRunner.run(
      makeCtx({ url: PUBLIC_URL, pieceId: null, audioOnly: false }, reported) as never,
    );
    // The two size-less lines arrive within the same millisecond, so the
    // second is swallowed by the UNKNOWN_SIZE_REPORT_MS throttle —
    // deliberately: these ticks carry no percentage, and their only job is to
    // keep `lastProgressAt` fresh, which the first one already does. The
    // terminal tick is reported outside StreamProgress and always lands.
    expect(reported).toEqual([
      { done: 5242880, total: 0, unit: "bytes" },
      { done: 1, total: 1, unit: "bytes" },
    ]);
  });

  it(
    "escalates to SIGKILL when the child ignores SIGTERM",
    async () => {
      writeFakeYtDlp(
        `echo "[download]  10.0% of   4.00MiB at  1.00MiB/s ETA 00:03"\n` +
          `trap '' TERM\n` +
          `sleep 60 </dev/null >/dev/null 2>&1 &\nSLEEP=$!\n` +
          `wait $SLEEP\n` +
          `printf 'late' > "$OUTDIR/late.mp4"\n`,
      );
      let cancel = false;
      const { reported, started, signal } = firstProgressSignal();
      const run = videoDownloadRunner.run(
        makeCtx({ url: PUBLIC_URL, pieceId: null, audioOnly: false }, reported, () => cancel, signal) as never,
      );
      await started;
      const cancelledAt = Date.now();
      cancel = true;
      await expect(run).rejects.toThrow(/cancelled/);
      const elapsed = Date.now() - cancelledAt;
      // The grace period really was served — SIGTERM alone did nothing, which
      // is the whole point of the escalation. A timer cannot fire EARLY, so
      // this bound is load-proof. There is deliberately no upper bound: the
      // only other way out is the script's `sleep 60`, which this test's 20 s
      // budget expires long before, so "it finished" already means the SIGKILL
      // landed. The old `< SIGKILL_AFTER_MS + 5_000` added nothing and turned
      // a busy machine into a red suite.
      expect(elapsed).toBeGreaterThanOrEqual(SIGKILL_AFTER_MS - 50);
      expect(storeFile).not.toHaveBeenCalled();
      expect(fs.existsSync(recordedOutDir())).toBe(false);
    },
    20_000,
  );
});
