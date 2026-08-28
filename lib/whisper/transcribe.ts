import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { requireUvBinary } from "@/lib/uv-path";
import { buildUvEnv } from "@/lib/uv-env/spawn-env";
import { resolveWhisperModel, whisperModelsDir } from "@/lib/whisper/models";
import type { ElevenLabsTranscription } from "@/lib/elevenlabs/transcribe";
import { hashSpec } from "@/lib/uv-env/hash-spec";
import { isTokenCurrent, writeInstallToken } from "@/lib/uv-env/install-token";
import { packageRoot } from "@/lib/runtime/package-root";

export const FASTER_WHISPER_VERSION = "1.1.1";

/** Pinned Python version for the faster-whisper env. We pin 3.12 to
 *  match the rest of libi's uv-managed envs (analyze, generate, TTS)
 *  and give every host a deterministic interpreter. 3.12 has full wheel
 *  coverage for faster-whisper + its native deps. */
export const WHISPER_PYTHON_VERSION = "3.12";

/** Single source of truth for the Whisper `--with` list. Consumed by
 *  both buildWhisperArgs (what we actually spawn) and
 *  whisperEnvSignature() (what the install-token marker hashes). Keep
 *  these aligned via this constant so any new dep automatically updates
 *  both. Mirrors lib/music/analyze.ts:ANALYZE_WITH_SPECS pattern.
 *
 *  `requests` is required because `faster-whisper` 1.1.1 does
 *  `import requests` at module load time in `faster_whisper/utils.py`
 *  but does NOT declare it in install_requires — it used to get pulled
 *  in transitively via `huggingface_hub` < 1.0, but huggingface_hub 1.x
 *  dropped `requests` from core deps. Without this explicit pin the env
 *  resolves cleanly then crashes at first `from faster_whisper import
 *  WhisperModel` with `No module named 'requests'`. Upstream issue:
 *  https://github.com/SYSTRAN/faster-whisper/issues — keep the pin
 *  until a faster-whisper release declares it directly. */
export const WHISPER_WITH_SPECS = [
  `faster-whisper==${FASTER_WHISPER_VERSION}`,
  "requests",
] as const;

export class WhisperTranscribeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhisperTranscribeError";
  }
}

function whisperScriptPath(): string {
  // cwd is the package root under `npx libi`, but the *user's* project dir
  // under `npx libi --connect-agent` — so fall back to a __dirname-relative
  // path (this file lives at <pkg>/lib/whisper/, script at <pkg>/mcp/whisper/).
  const candidates = [
    path.join(process.cwd(), "mcp/whisper/transcribe.py"),
    path.resolve(__dirname, "../../mcp/whisper/transcribe.py"),
    // Depth-independent: the compiled mirror (scripts/build-cli.js) puts this
    // module at dist-cli/lib/whisper/, one level deeper than source, so the
    // `../..` above resolves inside dist-cli/ instead of the package root.
    path.join(packageRoot(), "mcp/whisper/transcribe.py"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

function resolveUvPath(): string {
  return requireUvBinary(WhisperTranscribeError, "Whisper");
}

export function buildWhisperArgs(opts: {
  scriptPath: string;
  audioPath?: string;
  model: string;
  downloadRoot: string;
  languageCode?: string;
  downloadOnly?: boolean;
}): string[] {
  const args = [
    "run",
    "--python",
    WHISPER_PYTHON_VERSION,
    ...WHISPER_WITH_SPECS.flatMap((s) => ["--with", s]),
    "python",
    opts.scriptPath,
  ];
  if (!opts.downloadOnly && opts.audioPath) args.push(opts.audioPath);
  args.push("--model", opts.model, "--download-root", opts.downloadRoot);
  if (opts.languageCode) args.push("--language", opts.languageCode);
  if (opts.downloadOnly) args.push("--download-only");
  return args;
}

export function parseWhisperStdout(stdout: string): ElevenLabsTranscription {
  const trimmed = stdout.trim();
  if (!trimmed)
    throw new WhisperTranscribeError("whisper produced empty stdout");
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    throw new WhisperTranscribeError(
      `whisper stdout was not JSON: ${trimmed.slice(0, 200)}`,
    );
  }
  if (
    typeof json !== "object" ||
    json === null ||
    typeof (json as Record<string, unknown>).text !== "string"
  ) {
    throw new WhisperTranscribeError(
      `whisper JSON missing 'text': ${JSON.stringify(json).slice(0, 200)}`,
    );
  }
  const typed = json as ElevenLabsTranscription;
  if (!Array.isArray(typed.words)) typed.words = [];
  return typed;
}

/** Progress callback: `(filesDone, filesTotal)` parsed from `PROGRESS x/y`
 *  stderr markers emitted by the Python download hook. */
type ProgressCb = (done: number, total: number) => void;

function runUv(
  args: string[],
  timeoutMs: number,
  onProgress?: ProgressCb,
): Promise<string> {
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
      reject(
        new WhisperTranscribeError(`whisper timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => {
      const s = d.toString();
      err += s;
      for (const m of s.matchAll(/PROGRESS (\d+)\/(\d+)/g)) {
        onProgress?.(Number(m[1]), Number(m[2]));
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new WhisperTranscribeError(`uv spawn failed: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new WhisperTranscribeError(
            `whisper exited ${code}: ${err.trim().slice(0, 500)}`,
          ),
        );
        return;
      }
      resolve(out);
    });
  });
}

export async function transcribeAudio(opts: {
  audioPath: string;
  model?: string;
  languageCode?: string;
}): Promise<ElevenLabsTranscription> {
  const model = resolveWhisperModel(opts.model);
  const args = buildWhisperArgs({
    scriptPath: whisperScriptPath(),
    audioPath: opts.audioPath,
    model,
    downloadRoot: whisperModelsDir(),
    languageCode: opts.languageCode,
  });
  // 30 min ceiling: long files on CPU + first-run wheel fetch.
  const stdout = await runUv(args, 30 * 60_000);
  const result = parseWhisperStdout(stdout);
  // Warm-env attestation: once the subprocess returned valid output we
  // know the spec resolved end-to-end. Sticky marker so the next call
  // skips needs_install if nothing changed.
  writeWhisperEnvToken();
  return result;
}

/** Stable signature for the Whisper env spec. Bumping FASTER_WHISPER_VERSION,
 *  WHISPER_PYTHON_VERSION, or adding a new --with will invalidate it. */
export function whisperEnvSignature(): string {
  return hashSpec(WHISPER_PYTHON_VERSION, WHISPER_WITH_SPECS);
}

const WHISPER_ENV_TOKEN = ".libi-whisper-env.install-token";

export function isWhisperEnvCurrent(): boolean {
  return isTokenCurrent(WHISPER_ENV_TOKEN, whisperEnvSignature());
}

export function writeWhisperEnvToken(): void {
  writeInstallToken(WHISPER_ENV_TOKEN, whisperEnvSignature());
}

export async function downloadModel(
  model: string,
  onProgress?: ProgressCb,
): Promise<void> {
  const args = buildWhisperArgs({
    scriptPath: whisperScriptPath(),
    model: resolveWhisperModel(model),
    downloadRoot: whisperModelsDir(),
    downloadOnly: true,
  });
  // 60 min: large-v3 is ~3 GB. `onProgress` receives per-file ticks from
  // the Python snapshot_download hook.
  await runUv(args, 60 * 60_000, onProgress);
}
