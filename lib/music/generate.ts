import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { requireUvBinary } from "@/lib/uv-path";
import { buildUvEnv } from "@/lib/uv-env/spawn-env";
import {
  ACESTEP_GIT_REPO,
  ACESTEP_GIT_SHA,
  ACESTEP_VERSION,
  aceStepModelsDir,
} from "@/lib/music/models";
import { hashSpec } from "@/lib/uv-env/hash-spec";
import { isTokenCurrent, writeInstallToken } from "@/lib/uv-env/install-token";
import { packageRoot } from "@/lib/runtime/package-root";

export const MAX_PROMPT_CHARS = 1000;
export const MAX_LYRICS_CHARS = 2000;

/** Minimum free RAM the ACE-Step generate subprocess needs to load the
 *  3.5B-param pipeline at bf16/fp16 + run inference without thrashing the
 *  host. Empirical: ~9 GB resident at load, ~12 GB peak during inference.
 *  We require a 14 GB headroom to leave the OS + browser/editor breathing
 *  room. Returning `status: "insufficient_memory"` is much friendlier than
 *  letting the kernel OOM-kill the user's machine. */
export const MUSIC_GENERATE_MIN_FREE_BYTES = 14 * 1024 * 1024 * 1024;

/** Polite human-readable copy for `insufficient_memory` hints. */
export function describeMemoryShortfall(
  freeBytes: number,
  totalBytes: number,
  requiredBytes: number = MUSIC_GENERATE_MIN_FREE_BYTES,
): string {
  const free = (freeBytes / 1024 / 1024 / 1024).toFixed(1);
  const total = (totalBytes / 1024 / 1024 / 1024).toFixed(0);
  const need = (requiredBytes / 1024 / 1024 / 1024).toFixed(0);
  return `Local music needs ~${need} GB of free RAM to load the ACE-Step pipeline (3.5B params at bf16/fp16); only ${free} GB free on this ${total} GB machine. Close some apps and retry, or use a paid music provider on explicit request.`;
}

/** Pinned Python version for ACE-Step.
 *  ace-step==0.1.0 depends on spacy==3.8.4, which only publishes wheels for
 *  cp310/cp311/cp312 (no cp313, no cp314). Without an explicit pin, uv falls
 *  back to the system Python and resolution fails on newer hosts. 3.12 is
 *  the highest version with full wheel coverage across the dep tree. */
export const ACESTEP_PYTHON_VERSION = "3.12";

/** Fixed `uv run` prefix; soundfile is used by the entrypoint to read
 *  back WAV metadata. The install spec is a git URL because the PyPI sdist
 *  is broken — see ACESTEP_GIT_SHA in lib/music/models.ts for the rationale
 *  and provenance. The wheel built from the repo installs as Python module
 *  `acestep` (no hyphen) — that's why the entrypoint imports
 *  `from acestep.pipeline_ace_step …`. Keep these in sync with the
 *  doc-string in mcp/music/generate.py. */
export const ACESTEP_INSTALL_SPEC = `ace-step @ git+${ACESTEP_GIT_REPO}@${ACESTEP_GIT_SHA}`;

/** ACE-Step's `save_wav_file` calls `torchaudio.save_with_torchcodec` for
 *  WAV output but `torchcodec` is NOT in ace-step's declared deps at this
 *  pinned SHA. Without it, diffusion completes (27/27 steps) and the run
 *  then dies on save with "TorchCodec is required for save_with_torchcodec".
 *  Pinned to 0.12.x — first version where cp312 macosx_14_0_arm64 ships
 *  and pure-pip-installable on every host that meets `requires_python`. */
export const TORCHCODEC_VERSION = "0.12.0";

/** Floor for numba so the resolver cannot pick a pre-3.10 llvmlite.
 *
 *  ace-step -> librosa 0.11.0 -> numba: left unconstrained, uv resolves
 *  numba==0.53.1, which pins llvmlite==0.36.0. That llvmlite's setup.py has a
 *  hard `_guard_py_ver` refusing anything outside >=3.6,<3.10, and it ships no
 *  wheel for modern interpreters — so it is built from source and dies with:
 *
 *    RuntimeError: Cannot install on Python version 3.12.13;
 *                  only versions >=3.6,<3.10 are supported.
 *
 *  ACESTEP_PYTHON_VERSION is 3.12 (spacy 3.8.4 publishes no cp313 wheels), so
 *  this failed 100% of the time — libi.generate_music is the DEFAULT music
 *  provider and could never install. Measured on macOS arm64, 2026-08-02.
 *
 *  A floor rather than an exact pin: the constraint we need is "new enough to
 *  have a wheel for our interpreter", and pinning would fight future Python
 *  bumps. Verified with `uv pip compile --python-version 3.12`: this resolves
 *  numba 0.66.0 / llvmlite 0.48.0 with no conflict. */
export const NUMBA_MIN_VERSION = "0.60";

/** Single source of truth for the ACE-Step `--with` list. Consumed by both
 *  ACESTEP_RUN_PREFIX (what we actually spawn) and aceStepEnvSignature()
 *  (what the install-token marker hashes). Keep these aligned via this
 *  constant so any new dep automatically updates both — silently splitting
 *  them would let the env gate report "current" while the subprocess spec
 *  drifts. Mirrors lib/music/analyze.ts:ANALYZE_WITH_SPECS. */
export const ACESTEP_WITH_SPECS = [
  ACESTEP_INSTALL_SPEC,
  "soundfile",
  `torchcodec==${TORCHCODEC_VERSION}`,
  `numba>=${NUMBA_MIN_VERSION}`,
] as const;

export const ACESTEP_RUN_PREFIX = [
  "run",
  "--python",
  ACESTEP_PYTHON_VERSION,
  ...ACESTEP_WITH_SPECS.flatMap((s) => ["--with", s]),
  "python",
];

/** Stable signature for the ACE-Step env spec. Bumping ACE-Step's git
 *  pin or TORCHCODEC_VERSION or python pin will invalidate it. */
export function aceStepEnvSignature(): string {
  return hashSpec(ACESTEP_PYTHON_VERSION, ACESTEP_WITH_SPECS);
}

const ACESTEP_ENV_TOKEN = ".libi-ace-step-env.install-token";

export function isAceStepEnvCurrent(): boolean {
  return isTokenCurrent(ACESTEP_ENV_TOKEN, aceStepEnvSignature());
}

export function writeAceStepEnvToken(): void {
  writeInstallToken(ACESTEP_ENV_TOKEN, aceStepEnvSignature());
}

export class AceStepGenerateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AceStepGenerateError";
  }
}

export interface GenerationResult {
  wavPath: string;
  sampleRate: number;
  durationSeconds: number;
  channels: number;
  instrumental: boolean;
  seed: number;
}

function scriptPath(): string {
  const candidates = [
    path.join(process.cwd(), "mcp/music/generate.py"),
    path.resolve(__dirname, "../../mcp/music/generate.py"),
    // Depth-independent: the compiled mirror (scripts/build-cli.js) puts this
    // module at dist-cli/lib/music/, one level deeper than source, so the
    // `../..` above resolves inside dist-cli/ instead of the package root.
    path.join(packageRoot(), "mcp/music/generate.py"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

function resolveUvPath(): string {
  return requireUvBinary(AceStepGenerateError, "Local music");
}

export function buildAceStepArgs(opts: {
  scriptPath: string;
  promptFile?: string;
  lyricsFile?: string;
  durationSeconds?: number;
  seed?: number;
  modelDir: string;
  outPath?: string;
  instrumental?: boolean;
  downloadOnly?: boolean;
}): string[] {
  const args = [...ACESTEP_RUN_PREFIX, opts.scriptPath];
  if (opts.downloadOnly) {
    args.push("--model-dir", opts.modelDir, "--download-only");
    return args;
  }
  args.push("--prompt-file", opts.promptFile as string);
  if (opts.lyricsFile) args.push("--lyrics-file", opts.lyricsFile);
  args.push("--duration", String(opts.durationSeconds ?? 30));
  args.push("--seed", String(opts.seed ?? 0));
  args.push("--model-dir", opts.modelDir);
  args.push("--out", opts.outPath as string);
  if (opts.instrumental) args.push("--instrumental");
  return args;
}

export function parseGenerateStdout(
  stdout: string,
): Omit<GenerationResult, "wavPath"> {
  const trimmed = stdout.trim();
  if (!trimmed) throw new AceStepGenerateError("acestep produced empty stdout");
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    throw new AceStepGenerateError(
      `acestep stdout was not JSON: ${trimmed.slice(0, 200)}`,
    );
  }
  const o = json as Record<string, unknown>;
  if (o.ok !== true || typeof o.sample_rate !== "number") {
    throw new AceStepGenerateError(
      `acestep JSON not ok: ${JSON.stringify(json).slice(0, 200)}`,
    );
  }
  return {
    sampleRate: o.sample_rate as number,
    durationSeconds: (o.duration_seconds as number) ?? 0,
    channels: (o.channels as number) ?? 1,
    instrumental: o.instrumental === true,
    seed: (o.seed as number) ?? 0,
  };
}

type ProgressCb = (done: number, total: number) => void;
type CancelCb = () => boolean;

/** Surface the most useful slice of ACE-Step stderr on failure.
 *  Python tracebacks land at the END of stderr; the FIRST 500 chars are
 *  almost always uv's "Installed N packages" banner + a torch deprecation
 *  warning, which tells you nothing about why the run died. We strip the
 *  per-step PROGRESS markers (they bloat the tail without adding signal),
 *  drop ANSI color codes (CI escape sequences are noise in the JSON
 *  envelope), and keep the last ~4 KB so the real exception line is
 *  visible without flooding the chat. */
export function formatStderrTail(raw: string, maxChars = 4000): string {
  // Drop ANSI escapes (uv colorizes its progress output).
  // eslint-disable-next-line no-control-regex
  const noAnsi = raw.replace(/\[[0-9;]*m/g, "");
  // Strip per-step PROGRESS markers — we already surfaced them via the
  // ctx.reportProgress() callback; they just dilute the traceback here.
  const noProgress = noAnsi
    .split("\n")
    .filter((line) => !/^PROGRESS \d+\/\d+/.test(line.trim()))
    .join("\n")
    .trim();
  if (noProgress.length <= maxChars) return noProgress;
  // Keep the TAIL — that's where the exception type, message, and stack
  // bottom live. Prefix a marker so a reader knows we elided.
  return `… (truncated, showing last ${maxChars} chars) …\n${noProgress.slice(-maxChars)}`;
}

function runUv(
  args: string[],
  timeoutMs: number,
  onProgress?: ProgressCb,
  shouldCancel?: CancelCb,
): Promise<string> {
  const uv = resolveUvPath();
  return new Promise((resolve, reject) => {
    const child = spawn(uv, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: buildUvEnv(),
    });
    let out = "";
    let err = "";
    let cancelled = false;
    function doCancel() {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(timer);
      clearInterval(cancelPoll);
      child.kill("SIGKILL");
      reject(new AceStepGenerateError("cancelled"));
    }
    const cancelPoll = setInterval(() => {
      if (shouldCancel?.()) doCancel();
    }, 1000);
    const timer = setTimeout(() => {
      clearInterval(cancelPoll);
      child.kill("SIGKILL");
      reject(new AceStepGenerateError(`acestep timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => {
      const s = d.toString();
      err += s;
      for (const m of s.matchAll(/PROGRESS (\d+)\/(\d+)/g)) {
        onProgress?.(Number(m[1]), Number(m[2]));
      }
      if (shouldCancel?.()) doCancel();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      clearInterval(cancelPoll);
      reject(new AceStepGenerateError(`uv spawn failed: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(cancelPoll);
      if (cancelled) {
        reject(new AceStepGenerateError("cancelled"));
        return;
      }
      if (code === 3) {
        reject(
          new AceStepGenerateError(
            `MODEL_LOAD_FAILED: ${formatStderrTail(err)}`,
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new AceStepGenerateError(
            `acestep exited ${code}: ${formatStderrTail(err)}`,
          ),
        );
        return;
      }
      resolve(out);
    });
  });
}

export async function generateMusic(
  opts: {
    prompt: string;
    lyrics?: string;
    durationSeconds?: number;
    instrumental?: boolean;
    seed?: number;
  },
  onProgress?: ProgressCb,
  shouldCancel?: CancelCb,
): Promise<GenerationResult> {
  const prompt = opts.prompt.trim();
  if (!prompt) throw new AceStepGenerateError("prompt is empty");
  if (prompt.length > MAX_PROMPT_CHARS)
    throw new AceStepGenerateError(
      `prompt too long (${prompt.length} > ${MAX_PROMPT_CHARS} chars)`,
    );
  const lyrics = opts.lyrics?.trim() ?? "";
  if (lyrics.length > MAX_LYRICS_CHARS)
    throw new AceStepGenerateError(
      `lyrics too long (${lyrics.length} > ${MAX_LYRICS_CHARS} chars)`,
    );
  const tmpBase = path.join(os.tmpdir(), `libi-music-${randomUUID()}`);
  const promptFile = `${tmpBase}.prompt.txt`;
  const lyricsFile = `${tmpBase}.lyrics.txt`;
  const outPath = `${tmpBase}.wav`;
  fs.writeFileSync(promptFile, prompt, "utf-8");
  const hasLyrics = lyrics.length > 0 && !opts.instrumental;
  if (hasLyrics) fs.writeFileSync(lyricsFile, lyrics, "utf-8");
  try {
    const args = buildAceStepArgs({
      scriptPath: scriptPath(),
      promptFile,
      lyricsFile: hasLyrics ? lyricsFile : undefined,
      durationSeconds: opts.durationSeconds ?? 30,
      seed: opts.seed ?? 0,
      modelDir: aceStepModelsDir(),
      outPath,
      instrumental: opts.instrumental || !hasLyrics,
    });
    // 60 min ceiling: long CPU diffusion + first-run wheel fetch.
    const stdout = await runUv(args, 60 * 60_000, onProgress, shouldCancel);
    const parsed = parseGenerateStdout(stdout);
    // Warm-env attestation: once the subprocess returned a real WAV we know
    // the spec resolved end-to-end. Sticky marker so the next call skips
    // needs_install if nothing changed.
    writeAceStepEnvToken();
    return { ...parsed, wavPath: outPath };
  } finally {
    fs.rmSync(promptFile, { force: true });
    fs.rmSync(lyricsFile, { force: true });
  }
}

/** Remove all model files (corrupt/partial self-heal + force re-download). */
export function clearModelDir(): void {
  fs.rmSync(aceStepModelsDir(), { recursive: true, force: true });
}

export async function downloadModel(onProgress?: ProgressCb): Promise<void> {
  const args = buildAceStepArgs({
    scriptPath: scriptPath(),
    modelDir: aceStepModelsDir(),
    downloadOnly: true,
  });
  // 90 min: ~5.5 GB HF pull + wheel fetch on a cold cache. `onProgress`
  // receives `PROGRESS <done>/<total>` file-count ticks from the Python
  // snapshot_download tqdm hook.
  await runUv(args, 90 * 60_000, onProgress);
}
