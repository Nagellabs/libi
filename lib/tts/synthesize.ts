import fs from "fs";
import os from "os";
import path from "path";
import https from "https";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { requireUvBinary } from "@/lib/uv-path";
import { buildUvEnv } from "@/lib/uv-env/spawn-env";
import {
  KOKORO_ONNX_VERSION,
  KOKORO_MODEL_URL,
  KOKORO_VOICES_URL,
  resolveVoice,
  voiceLang,
  ttsModelsDir,
  kokoroModelPaths,
} from "@/lib/tts/voices";
import { hashSpec } from "@/lib/uv-env/hash-spec";
import { isTokenCurrent, writeInstallToken } from "@/lib/uv-env/install-token";
import { packageRoot } from "@/lib/runtime/package-root";

export const MAX_TTS_CHARS = 5000;

/** Pinned Python version for the Kokoro env. Matches the rest of libi's
 *  uv-managed envs (analyze, generate, whisper) to give every host a
 *  deterministic interpreter. */
export const TTS_PYTHON_VERSION = "3.12";

/** Single source of truth for the Kokoro `--with` list. Consumed by both
 *  KOKORO_RUN_PREFIX (what we actually spawn) and ttsEnvSignature() (what
 *  the install-token marker hashes). Keep these aligned via this constant
 *  so any new dep automatically updates both. Mirrors
 *  lib/music/analyze.ts:ANALYZE_WITH_SPECS pattern.
 *
 *  soundfile is used directly by the entrypoint to write the WAV. It is a
 *  transitive dep of kokoro-onnx, but pin it explicitly so a kokoro-onnx
 *  minor bump can't silently drop the direct import. */
export const TTS_WITH_SPECS = [
  `kokoro-onnx==${KOKORO_ONNX_VERSION}`,
  "soundfile",
] as const;

/** Fixed `uv run` prefix; the script path + flags are appended. */
export const KOKORO_RUN_PREFIX = [
  "run",
  "--python",
  TTS_PYTHON_VERSION,
  ...TTS_WITH_SPECS.flatMap((s) => ["--with", s]),
  "python",
];

export class KokoroSynthesizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KokoroSynthesizeError";
  }
}

export interface SynthWord {
  text: string;
  start: number;
  end: number;
}

export interface SynthesisResult {
  wavPath: string;
  voice: string;
  sampleRate: number;
  durationSeconds: number;
  words: SynthWord[];
  approximate: boolean;
}

function ttsScriptPath(): string {
  const candidates = [
    path.join(process.cwd(), "mcp/tts/synthesize.py"),
    path.resolve(__dirname, "../../mcp/tts/synthesize.py"),
    // Depth-independent: the compiled mirror (scripts/build-cli.js) puts this
    // module at dist-cli/lib/tts/, one level deeper than source, so the
    // `../..` above resolves inside dist-cli/ instead of the package root.
    path.join(packageRoot(), "mcp/tts/synthesize.py"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

function resolveUvPath(): string {
  return requireUvBinary(KokoroSynthesizeError, "Local TTS");
}

export function buildKokoroArgs(opts: {
  scriptPath: string;
  textFile?: string;
  voice?: string;
  speed?: number;
  lang?: string;
  modelDir: string;
  outPath?: string;
  timestamps?: boolean;
  downloadOnly?: boolean;
}): string[] {
  const args = [...KOKORO_RUN_PREFIX, opts.scriptPath];
  if (opts.downloadOnly) {
    args.push("--model-dir", opts.modelDir, "--download-only");
    return args;
  }
  args.push("--text-file", opts.textFile as string);
  args.push("--voice", opts.voice as string);
  args.push("--speed", String(opts.speed ?? 1.0));
  args.push("--lang", opts.lang as string);
  args.push("--model-dir", opts.modelDir);
  args.push("--out", opts.outPath as string);
  if (opts.timestamps) args.push("--timestamps");
  return args;
}

export function parseSynthesisStdout(
  stdout: string,
): Omit<SynthesisResult, "wavPath"> {
  const trimmed = stdout.trim();
  if (!trimmed)
    throw new KokoroSynthesizeError("kokoro produced empty stdout");
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    throw new KokoroSynthesizeError(
      `kokoro stdout was not JSON: ${trimmed.slice(0, 200)}`,
    );
  }
  const o = json as Record<string, unknown>;
  if (o.ok !== true || typeof o.sample_rate !== "number") {
    throw new KokoroSynthesizeError(
      `kokoro JSON not ok: ${JSON.stringify(json).slice(0, 200)}`,
    );
  }
  return {
    voice: String(o.voice),
    sampleRate: o.sample_rate as number,
    durationSeconds: (o.duration_seconds as number) ?? 0,
    words: Array.isArray(o.words) ? (o.words as SynthWord[]) : [],
    approximate: o.approximate === true,
  };
}

function runUv(args: string[], timeoutMs: number): Promise<string> {
  const uv = resolveUvPath();
  return new Promise((resolve, reject) => {
    const child = spawn(uv, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildUvEnv(),
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new KokoroSynthesizeError(`kokoro timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new KokoroSynthesizeError(`uv spawn failed: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new KokoroSynthesizeError(
            `kokoro exited ${code}: ${err.trim().slice(0, 500)}`,
          ),
        );
        return;
      }
      resolve(out);
    });
  });
}

export async function synthesizeSpeech(opts: {
  text: string;
  voice?: string;
  speed?: number;
  withTimestamps?: boolean;
}): Promise<SynthesisResult> {
  const text = opts.text.trim();
  if (!text) throw new KokoroSynthesizeError("text is empty");
  if (text.length > MAX_TTS_CHARS)
    throw new KokoroSynthesizeError(
      `text too long (${text.length} > ${MAX_TTS_CHARS} chars)`,
    );
  const voice = resolveVoice(opts.voice);
  const tmpBase = path.join(os.tmpdir(), `libi-tts-${randomUUID()}`);
  const textFile = `${tmpBase}.txt`;
  const outPath = `${tmpBase}.wav`;
  fs.writeFileSync(textFile, text, "utf-8");
  try {
    const args = buildKokoroArgs({
      scriptPath: ttsScriptPath(),
      textFile,
      voice,
      speed: opts.speed ?? 1.0,
      lang: voiceLang(voice),
      modelDir: ttsModelsDir(),
      outPath,
      timestamps: opts.withTimestamps,
    });
    // 10 min ceiling: long text on CPU + first-run wheel fetch.
    const stdout = await runUv(args, 10 * 60_000);
    const parsed = parseSynthesisStdout(stdout);
    // Warm-env attestation: once the subprocess returned valid output we
    // know the spec resolved end-to-end. Sticky marker so the next call
    // skips needs_install if nothing changed.
    writeTtsEnvToken();
    return { ...parsed, wavPath: outPath };
  } finally {
    fs.rmSync(textFile, { force: true });
  }
}

/** Aggregate byte-progress callback: `(bytesDone, bytesTotal)` summed
 *  across the Kokoro model files. */
type ProgressCb = (bytesDone: number, bytesTotal: number) => void;

/** Per-file chunk callback used by {@link httpsDownload}. */
type ChunkCb = (chunkBytes: number, contentLength: number) => void;

type Fetcher = (url: string, dest: string, onChunk?: ChunkCb) => Promise<void>;

function httpsDownload(
  url: string,
  dest: string,
  onChunk?: ChunkCb,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.part`;
    const file = fs.createWriteStream(tmp);
    file.on("error", (e) => {
      fs.rmSync(tmp, { force: true });
      reject(new KokoroSynthesizeError(`download ${url} write failed: ${e.message}`));
    });
    const go = (u: string, redirects: number) => {
      https
        .get(u, (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location &&
            redirects < 5
          ) {
            res.resume();
            go(res.headers.location, redirects + 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(
              new KokoroSynthesizeError(
                `download ${u} failed: HTTP ${res.statusCode}`,
              ),
            );
            res.resume();
            return;
          }
          if (onChunk) {
            const contentLength = Number(res.headers["content-length"] ?? 0);
            res.on("data", (chunk: Buffer) =>
              onChunk(chunk.length, contentLength),
            );
          }
          res.pipe(file);
          file.on("finish", () => file.close(() => {
            fs.renameSync(tmp, dest);
            resolve();
          }));
        })
        .on("error", (e) => {
          fs.rmSync(tmp, { force: true });
          reject(new KokoroSynthesizeError(`download ${u} failed: ${e.message}`));
        });
    };
    go(url, 0);
  });
}

/** Ensure both Kokoro model files exist under the models dir. Existing
 *  non-empty files are left alone (idempotent). */
export async function fetchModelFiles(
  fetcher: Fetcher = httpsDownload,
  onProgress?: ProgressCb,
): Promise<void> {
  const { onnxPath, voicesPath } = kokoroModelPaths();
  fs.mkdirSync(ttsModelsDir(), { recursive: true });
  const jobs: Array<[string, string]> = [
    [KOKORO_MODEL_URL, onnxPath],
    [KOKORO_VOICES_URL, voicesPath],
  ];
  // Aggregate byte progress across the (up to 2) files. Each file's total
  // is discovered from its Content-Length on the first chunk, so the
  // aggregate total grows as later files start downloading.
  let bytesDone = 0;
  const fileTotals = new Map<string, number>();
  for (const [url, dest] of jobs) {
    let ok = false;
    try {
      ok = fs.statSync(dest).size > 0;
    } catch {
      ok = false;
    }
    if (!ok) {
      await fetcher(url, dest, (chunkBytes, contentLength) => {
        bytesDone += chunkBytes;
        fileTotals.set(dest, contentLength);
        let total = 0;
        for (const v of fileTotals.values()) total += v;
        onProgress?.(bytesDone, total);
      });
    }
  }
}

/** Stable signature for the TTS env spec. Bumping KOKORO_ONNX_VERSION,
 *  TTS_PYTHON_VERSION, or adding a new --with will invalidate it. */
export function ttsEnvSignature(): string {
  return hashSpec(TTS_PYTHON_VERSION, TTS_WITH_SPECS);
}

const TTS_ENV_TOKEN = ".libi-tts-env.install-token";

export function isTtsEnvCurrent(): boolean {
  return isTokenCurrent(TTS_ENV_TOKEN, ttsEnvSignature());
}

export function writeTtsEnvToken(): void {
  writeInstallToken(TTS_ENV_TOKEN, ttsEnvSignature());
}

export async function downloadModel(onProgress?: ProgressCb): Promise<void> {
  // The real bytes (~110 MB across 2 GitHub files) download here; the
  // runUv step below only validates + warms the wheel cache.
  await fetchModelFiles(httpsDownload, onProgress);
  const args = buildKokoroArgs({
    scriptPath: ttsScriptPath(),
    modelDir: ttsModelsDir(),
    downloadOnly: true,
  });
  // 20 min: wheel fetch + Kokoro load on a cold cache.
  await runUv(args, 20 * 60_000);
}
