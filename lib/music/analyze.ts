import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { requireUvBinary } from "@/lib/uv-path";
import { buildUvEnv } from "@/lib/uv-env/spawn-env";
import { hashSpec } from "@/lib/uv-env/hash-spec";
import { formatStderrTail } from "@/lib/music/generate";
import { packageRoot } from "@/lib/runtime/package-root";

export const ANALYZE_PYTHON_VERSION = "3.12";
export const LIBROSA_VERSION = "0.11.0";
export const ANALYZE_WITH_SPECS = [
  `librosa==${LIBROSA_VERSION}`,
  "soundfile",
] as const;
export const ANALYZE_RUN_PREFIX = [
  "run",
  "--python",
  ANALYZE_PYTHON_VERSION,
  ...ANALYZE_WITH_SPECS.flatMap((s) => ["--with", s]),
  "python",
];

/** Stable hash of the install spec. Used as the install-token contents so
 *  any change to LIBROSA_VERSION / ANALYZE_PYTHON_VERSION / withSpecs
 *  triggers a needs_install round-trip on the next tool call. */
export function musicAnalysisEnvSignature(): string {
  return hashSpec(ANALYZE_PYTHON_VERSION, ANALYZE_WITH_SPECS);
}

/** Free-RAM gate before spawning librosa. librosa is cheap, but failing
 *  fast on a thrashing host is much friendlier than letting the kernel
 *  OOM-kill the subprocess. Same helper used by music_generate. */
export const MUSIC_ANALYZE_MIN_FREE_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB

export class MusicAnalyzeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MusicAnalyzeError";
  }
}

export interface BeatsResult {
  tempo: number;
  tempoConfidence: number;
  beatTimes: number[];
  onsetTimes: number[];
  durationSeconds: number;
  truncated: boolean;
}

export interface ProfileResult {
  durationSeconds: number;
  tempo: number;
  tempoConfidence: number;
  keyEstimate: { tonic: string; mode: "major" | "minor"; confidence: number };
  energyMean: number;
  brightnessMean: number;
  percussiveness: number;
  loudnessLufs: number;
  descriptors: string[];
  suggestedPrompt: string;
  truncated: boolean;
  beats?: { times: number[] };
  bands?: {
    sampleRateHz: number;
    bass: number[];
    mid: number[];
    treble: number[];
  };
}

export interface RunOpts {
  mode: "beats" | "profile";
  inPath: string;
  startSec?: number;
  endSec?: number;
  minBpm?: number;
  maxBpm?: number;
  includeBeats?: boolean;
  bandEnvelopes?: boolean;
  envelopeHz?: number;
}

function scriptPath(): string {
  const candidates = [
    path.join(process.cwd(), "mcp/music/analyze.py"),
    path.resolve(__dirname, "../../mcp/music/analyze.py"),
    // Depth-independent: the compiled mirror (scripts/build-cli.js) puts this
    // module at dist-cli/lib/music/, one level deeper than source, so the
    // `../..` above resolves inside dist-cli/ instead of the package root.
    path.join(packageRoot(), "mcp/music/analyze.py"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

export function buildAnalyzeArgs(opts: RunOpts, outPath: string): string[] {
  const args = [
    ...ANALYZE_RUN_PREFIX,
    scriptPath(),
    "--mode",
    opts.mode,
    "--in",
    opts.inPath,
    "--out",
    outPath,
  ];
  if (opts.startSec !== undefined) args.push("--start", String(opts.startSec));
  if (opts.endSec !== undefined) args.push("--end", String(opts.endSec));
  if (opts.minBpm !== undefined) args.push("--min-bpm", String(opts.minBpm));
  if (opts.maxBpm !== undefined) args.push("--max-bpm", String(opts.maxBpm));
  if (opts.includeBeats) args.push("--include-beats");
  if (opts.bandEnvelopes) args.push("--band-envelopes");
  if (opts.envelopeHz !== undefined) args.push("--envelope-hz", String(opts.envelopeHz));
  return args;
}

export function parseAnalyzeOutput<T>(jsonText: string): T {
  const t = jsonText.trim();
  if (!t) throw new MusicAnalyzeError("analyze.py produced empty output");
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(t) as Record<string, unknown>;
  } catch {
    throw new MusicAnalyzeError(
      `analyze.py output was not JSON: ${t.slice(0, 200)}`,
    );
  }
  if (j.ok !== true) {
    throw new MusicAnalyzeError(
      `analyze.py envelope not ok: ${JSON.stringify(j).slice(0, 200)}`,
    );
  }
  delete j.ok;
  return j as T;
}

function runUv(args: string[], timeoutMs = 5 * 60_000): Promise<void> {
  const uv = requireUvBinary(MusicAnalyzeError, "Music analysis");
  return new Promise((resolve, reject) => {
    const child = spawn(uv, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: buildUvEnv(),
    });
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new MusicAnalyzeError(`analyze timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", () => {}); // analyze.py never writes stdout, drain anyway
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new MusicAnalyzeError(`uv spawn failed: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else if (code === 2) reject(new MusicAnalyzeError(`usage_error: ${formatStderrTail(err)}`));
      else reject(new MusicAnalyzeError(`exited ${code}: ${formatStderrTail(err)}`));
    });
  });
}

export async function runMusicAnalyze<T>(opts: RunOpts): Promise<T> {
  // available-memory helper is darwin-aware; use it for the real gate.
  // We import lazily to avoid a circular when the helper grows.
  const { getAvailableMemoryBytes } = await import("@/lib/system/available-memory");
  if (getAvailableMemoryBytes() < MUSIC_ANALYZE_MIN_FREE_BYTES) {
    throw new MusicAnalyzeError(
      `insufficient_memory: needs ~1 GB free, have ${(getAvailableMemoryBytes() / 1e9).toFixed(1)} GB`,
    );
  }
  const outPath = path.join(os.tmpdir(), `libi-analyze-${randomUUID()}.json`);
  try {
    await runUv(buildAnalyzeArgs(opts, outPath));
    const text = fs.readFileSync(outPath, "utf-8");
    return parseAnalyzeOutput<T>(text);
  } finally {
    fs.rmSync(outPath, { force: true });
  }
}

/** The caller-facing option set (RunOpts minus the internal mode switch). */
export type MusicAnalyzeOptions = Omit<RunOpts, "mode">;

export const detectBeats = (opts: MusicAnalyzeOptions) =>
  runMusicAnalyze<BeatsResult>({ ...opts, mode: "beats" });

export const profile = (opts: MusicAnalyzeOptions) =>
  runMusicAnalyze<ProfileResult>({ ...opts, mode: "profile" });
