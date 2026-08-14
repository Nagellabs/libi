/**
 * Custom installer for the local tracking engine (Task 11).
 *
 * Two responsibilities, run as one `install()`:
 *   1. `uv sync` the uv-managed Python sidecar project at
 *      `mcp/tracking/py/` so onnxruntime / boxmot / opencv / torch are
 *      resolved into its `.venv` (creating it on first run).
 *   2. Ensure the tracking model artifacts declared in
 *      `mcp/tracking/py/models.json` are present under
 *      `~/.libi/models/tracking/` (= `trackingModelsDir()`) — sha-pinned
 *      direct downloads plus the locally-exported yoloe11 ONNX.
 *
 * The `CustomInstaller` interface in `mcp/registry/types.ts` is a static
 * `{ verify, install: { command, args } }` spec spawned via `execFile`.
 * That cannot express this multi-step flow, so — exactly like the
 * `yt-dlp-uv` precedent in `mcp/registry/installers.ts` — the spec uses a
 * sentinel `command` (`__TRACKING_PYENV_INSTALL__`) that
 * `DependencyManager.runCustomInstaller` special-cases to call
 * `runTrackingPyenvInstall()` here.
 *
 * Model acquisition handles BOTH kinds declared in models.json
 * (`acquisition`):
 *   - `direct-download`: if the dest file is missing OR its sha256
 *     differs from models.json, download from `url` and verify sha256
 *     (hard-fail on mismatch).
 *   - `build-at-install`: the artifact is EXPORTED ON THE USER'S MACHINE
 *     from sha-pinned inputs declared in the entry's `build` spec (source
 *     .pt + text encoder + CLIP commit archive). The output sha256 is
 *     host-specific (the ONNX export embeds non-deterministic metadata), so
 *     integrity is anchored on the INPUTS: a `<dest>.build-info.json` marker
 *     records the exact inputs + the produced output sha, and the build is
 *     skipped iff the dest hashes to the recorded output AND the recorded
 *     inputs equal the manifest's current inputs. Building locally (owner
 *     decision, 2026-08-01) also avoids libi redistributing an AGPL-derived
 *     binary — ultralytics, the YOLOE weights, and the ultralytics/CLIP fork
 *     are all AGPL-3.0, while libi is GPL-3.0.
 *
 * This file is server-only (imports `fs`, spawns processes). It is
 * referenced from `installers.ts` (also server-only) so it never reaches
 * the client bundle that imports `bundled.ts` via the Settings UI.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildUvEnv, trackingVenvDir } from "@/lib/uv-env/spawn-env";
import { downloadToFileWithStallGuard } from "@/lib/security/download-verify";
import {
  uvPath,
  sidecarProjectDir,
  trackingModelsDir,
} from "@/lib/tracking/engine-deps";
import { serverLogger as logger } from "@/lib/logger";
import type { CustomInstaller } from "../types";

const pexec = promisify(execFile);

/** Bump when changing the sidecar pin set or model manifest. Mirrors the BundledDependency.pinnedInstallToken date convention. */
/*
 * Bumped 2026-08-01: yoloe11.onnx moved from reproduce-at-build (manual
 * export, blocked every clean install) to build-at-install (the installer
 * exports it unattended from sha-pinned inputs), and the dead `osnet_reid`
 * ONNX entry was removed (boxmot's runtime PyTorch ReID backend was already
 * the shipped behaviour). The bump makes existing installs run the new
 * model phase once (idempotent: an already-built yoloe11.onnx without a
 * build-info marker is rebuilt once, then skipped on every later run).
 */
export const TRACKING_PYENV_TOKEN = "tracking-pyenv@2026-08-01-yoloe-build-at-install";

/** Sentinel `command`; DependencyManager.runCustomInstaller dispatches it. */
export const TRACKING_PYENV_SENTINEL = "__TRACKING_PYENV_INSTALL__";

export interface TextEncoderSpec {
  /** Path RELATIVE to the models dir (e.g. ".build/mobileclip_blt.ts"). */
  file: string;
  url: string;
  sha256: string;
  sizeBytes: number;
}

/** Declared inputs of a `build-at-install` export (models.json `build`). */
export interface BuildSpec {
  /** models.json id of the sha-pinned source checkpoint (e.g. "yoloe_vp"). */
  sourceModelId: string;
  classes: string[];
  imgsz: number;
  opset: number;
  /** PEP 508 requirement for the export-only CLIP tokenizer package, pinned
   *  to an immutable commit-archive URL. Supplied via `uv run --with` so the
   *  locked sidecar venv is never mutated. */
  clipRequirement: string;
  textEncoder: TextEncoderSpec;
}

export interface ModelEntry {
  id: string;
  file: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  dest: string;
  acquisition: "direct-download" | "build-at-install";
  build?: BuildSpec;
}

/** The exact input pins a built artifact was produced from. Persisted in the
 *  build-info marker and compared against the manifest to decide rebuilds. */
export interface BuildInputs {
  sourcePtSha256: string;
  textEncoderSha256: string;
  clipRequirement: string;
  classes: string[];
  imgsz: number;
  opset: number;
}

export interface BuildInfo {
  inputs: BuildInputs;
  output: { sha256: string; sizeBytes: number; ultralytics?: string };
  builtAt: string;
}

function modelsManifestPath(): string {
  return path.join(sidecarProjectDir(), "models.json");
}

function readModelsManifest(): ModelEntry[] {
  const p = modelsManifestPath();
  const raw = fs.readFileSync(p, "utf-8");
  const parsed = JSON.parse(raw) as ModelEntry[];
  if (!Array.isArray(parsed)) {
    throw new Error(`models.json at ${p} is not a JSON array`);
  }
  return parsed;
}

function sha256File(p: string): string {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(p))
    .digest("hex")
    .toLowerCase();
}

/** The token marker for the synced uv env + provisioned models. */
function tokenMarkerPath(): string {
  return path.join(trackingModelsDir(), ".install-token");
}

function readToken(): string | null {
  try {
    return fs.readFileSync(tokenMarkerPath(), "utf-8").trim();
  } catch {
    return null;
  }
}

function writeToken(): void {
  const p = tokenMarkerPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, TRACKING_PYENV_TOKEN, "utf-8");
}

/**
 * Download `url` to `dest`, streaming to disk while hashing (the mobileclip
 * text encoder is ~572MB — never buffer whole files in memory). Verifies the
 * sha256 and renames atomically so a partial download never looks present.
 */
export async function downloadVerified(
  url: string,
  sha256: string,
  dest: string,
  label: string,
): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  logger.info(
    { tag: "tracking-pyenv", op: "model_download_start", id: label, url },
    `downloading ${label}`,
  );
  // Stall-guarded + retrying + HTTPS-only-redirect, streaming to disk.
  //
  // This used to be a bare `fetch(url, { redirect: "follow" })`. Measured
  // 2026-08-02 on a real clean install: the 572 MB MobileCLIP encoder stalled
  // mid-body, undici's default body timeout fired as UND_ERR_BODY_TIMEOUT, and
  // the whole tracking provision died with an unhandled stack trace and no
  // retry — the SAME failure #54 fixed for binary deps, on the path that pulls
  // by far the largest artifacts. Buffering is not an option at this size, so
  // this streams and hashes as it writes.
  const { tmpPath, bytesDownloaded, sha256: actual } =
    await downloadToFileWithStallGuard(url, dest, {
      label,
      onRetry: (info) => {
        logger.warn(
          {
            tag: "tracking-pyenv",
            op: "model_download_retry",
            id: label,
            url,
            attempt: info.attempt,
            maxAttempts: info.maxAttempts,
            bytesDownloaded: info.bytesDownloaded,
            err: info.error,
          },
          `${label} download failed (attempt ${info.attempt}/${info.maxAttempts}), retrying`,
        );
      },
    });

  if (actual !== sha256.toLowerCase()) {
    fs.rmSync(tmpPath, { force: true });
    throw new Error(
      `sha256 mismatch for ${label}: expected ${sha256.toLowerCase()}, ` +
        `got ${actual} (downloaded from ${url})`,
    );
  }
  fs.renameSync(tmpPath, dest);
  logger.info(
    {
      tag: "tracking-pyenv",
      op: "model_download_done",
      id: label,
      dest,
      size: bytesDownloaded,
    },
    `downloaded ${label} (${bytesDownloaded} bytes, sha ok)`,
  );
}

/**
 * Ensure a single `direct-download` model artifact is on disk.
 * Returns nothing; throws an actionable error on any unrecoverable state.
 * `build-at-install` entries go through {@link ensureBuiltModel} instead.
 */
export async function ensureModel(
  entry: ModelEntry,
  modelsDir: string,
): Promise<void> {
  if (entry.acquisition !== "direct-download") {
    throw new Error(
      `ensureModel only handles direct-download entries; ${entry.id} is ` +
        `${entry.acquisition} — route it through ensureBuiltModel`,
    );
  }
  const dest = path.join(modelsDir, entry.dest);

  // present-and-matching short-circuits the fetch.
  if (fs.existsSync(dest)) {
    const actual = sha256File(dest);
    if (actual === entry.sha256.toLowerCase()) {
      logger.info(
        { tag: "tracking-pyenv", op: "model_present", id: entry.id, dest },
        `tracking model ${entry.id} present (sha matches)`,
      );
      return;
    }
    logger.warn(
      {
        tag: "tracking-pyenv",
        op: "model_sha_mismatch",
        id: entry.id,
        dest,
        expected: entry.sha256.toLowerCase(),
        actual,
      },
      `tracking model ${entry.id} sha mismatch — re-downloading`,
    );
  }

  // dest may be nested (e.g. "matanyone/model.safetensors") — downloadVerified
  // creates the full parent chain, not just the models root.
  await downloadVerified(entry.url, entry.sha256, dest, entry.id);
}

/**
 * Resolve the declared build inputs of a `build-at-install` entry against the
 * manifest (pure — exported for unit tests). The result is what gets recorded
 * in the build-info marker and compared to decide whether a rebuild is needed.
 */
export function buildInputsOf(
  entry: ModelEntry,
  manifest: ModelEntry[],
): BuildInputs {
  const build = entry.build;
  if (!build) {
    throw new Error(`model ${entry.id} is build-at-install but has no build spec`);
  }
  const source = manifest.find((m) => m.id === build.sourceModelId);
  if (!source) {
    throw new Error(
      `model ${entry.id} build.sourceModelId "${build.sourceModelId}" not in models.json`,
    );
  }
  return {
    sourcePtSha256: source.sha256.toLowerCase(),
    textEncoderSha256: build.textEncoder.sha256.toLowerCase(),
    clipRequirement: build.clipRequirement,
    classes: [...build.classes],
    imgsz: build.imgsz,
    opset: build.opset,
  };
}

function readBuildInfo(destPath: string): BuildInfo | null {
  try {
    return JSON.parse(
      fs.readFileSync(`${destPath}.build-info.json`, "utf-8"),
    ) as BuildInfo;
  } catch {
    return null;
  }
}

/**
 * Is the built artifact at `destPath` current for `expected` inputs?
 * True iff dest exists, the build-info marker parses, the recorded inputs
 * deep-equal the manifest's current inputs, AND the file on disk still hashes
 * to the recorded output sha (guards a corrupted/partial file).
 */
export function isBuildCurrent(
  destPath: string,
  expected: BuildInputs,
): boolean {
  if (!fs.existsSync(destPath)) return false;
  const info = readBuildInfo(destPath);
  if (!info?.inputs || !info.output?.sha256) return false;
  if (JSON.stringify(info.inputs) !== JSON.stringify(expected)) return false;
  return sha256File(destPath) === info.output.sha256.toLowerCase();
}

type ExecFn = (
  cmd: string,
  args: string[],
  opts: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;

/** Scan stdout lines from the END for the export script's protocol JSON
 *  (`{"type":"export",...}`), skipping ultralytics/uv progress chatter. */
export function parseExportResult(
  stdout: string,
): { ok: boolean; [k: string]: unknown } | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as { type?: string; ok?: boolean };
      if (parsed.type === "export") {
        return parsed as { ok: boolean; [k: string]: unknown };
      }
    } catch {
      /* not JSON — keep scanning */
    }
  }
  return null;
}

/**
 * Ensure a `build-at-install` artifact exists and is current, exporting it
 * on this machine when it isn't. All inputs are sha-pinned and verified
 * BEFORE the export runs; the export itself is validated by
 * `export_yoloe11.py` (onnxruntime tensor-shape check) and the result is
 * recorded in `<dest>.build-info.json` so later installs skip the work.
 *
 * `exec` is injectable for hermetic tests; production uses promisified
 * execFile.
 */
export async function ensureBuiltModel(
  entry: ModelEntry,
  manifest: ModelEntry[],
  modelsDir: string,
  exec: ExecFn = pexec as unknown as ExecFn,
): Promise<void> {
  const build = entry.build;
  if (!build) {
    throw new Error(`model ${entry.id} is build-at-install but has no build spec`);
  }
  const dest = path.join(modelsDir, entry.dest);
  const expected = buildInputsOf(entry, manifest);

  if (isBuildCurrent(dest, expected)) {
    logger.info(
      { tag: "tracking-pyenv", op: "model_present", id: entry.id, dest },
      `tracking model ${entry.id} present (build-info current)`,
    );
    return;
  }

  // 1. The sha-pinned source checkpoint must already be provisioned (the
  //    direct-download phase runs before the build phase).
  const source = manifest.find((m) => m.id === build.sourceModelId)!;
  const sourcePt = path.join(modelsDir, source.dest);
  if (!fs.existsSync(sourcePt)) {
    throw new Error(
      `cannot build ${entry.dest}: source checkpoint ${source.dest} is not ` +
        `provisioned at ${sourcePt} (the direct-download phase must run first)`,
    );
  }

  // 2. Ensure the export-only text encoder (sha-verified, cached under the
  //    models dir so a rebuild after a token bump never re-downloads 572MB).
  const encoderPath = path.join(modelsDir, build.textEncoder.file);
  const encoderOk =
    fs.existsSync(encoderPath) &&
    sha256File(encoderPath) === build.textEncoder.sha256.toLowerCase();
  if (!encoderOk) {
    await downloadVerified(
      build.textEncoder.url,
      build.textEncoder.sha256,
      encoderPath,
      `${entry.id} text encoder`,
    );
  }

  // 3. Run the export inside the locked sidecar env, with the pinned CLIP
  //    tokenizer supplied as an ephemeral `--with` overlay (the venv itself
  //    is never mutated; uv caches the overlay under <LIBI_HOME>/uv/cache).
  const proj = sidecarProjectDir();
  const args = [
    "run",
    "--locked",
    "--with",
    build.clipRequirement,
    "python",
    "export_yoloe11.py",
    "--pt",
    sourcePt,
    "--encoder",
    encoderPath,
    "--out",
    dest,
    "--classes",
    build.classes.join(","),
    "--imgsz",
    String(build.imgsz),
    "--opset",
    String(build.opset),
  ];
  logger.info(
    { tag: "tracking-pyenv", op: "model_build_start", id: entry.id, dest },
    `building tracking model ${entry.id} (local ONNX export)`,
  );
  let stdout = "";
  let stderr = "";
  try {
    ({ stdout, stderr } = await exec(uvPath(), args, {
      cwd: proj,
      timeout: 15 * 60_000, // first run resolves the CLIP overlay + exports
      maxBuffer: 32 * 1024 * 1024,
      env: buildUvEnv({
        UV_PROJECT_ENVIRONMENT: trackingVenvDir(),
        NO_COLOR: "1",
      }),
    }));
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string };
    const detail = (err.stderr ?? err.stdout ?? err.message ?? "").slice(-2000);
    throw new Error(
      `local ONNX export for ${entry.dest} failed: ${err.message}\n${detail}`,
    );
  }
  const result = parseExportResult(stdout);
  if (!result || !result.ok) {
    const detail = result?.error ?? stderr.slice(-2000);
    throw new Error(
      `local ONNX export for ${entry.dest} did not succeed: ${String(detail)}`,
    );
  }
  if (!fs.existsSync(dest)) {
    throw new Error(
      `local ONNX export for ${entry.dest} reported ok but ${dest} is missing`,
    );
  }

  // 4. Record the build so later installs are a cheap hash + compare.
  const outSha = sha256File(dest);
  const info: BuildInfo = {
    inputs: expected,
    output: {
      sha256: outSha,
      sizeBytes: fs.statSync(dest).size,
      ultralytics:
        typeof result.ultralytics === "string" ? result.ultralytics : undefined,
    },
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(`${dest}.build-info.json`, JSON.stringify(info, null, 2));
  logger.info(
    {
      tag: "tracking-pyenv",
      op: "model_build_done",
      id: entry.id,
      dest,
      sha256: outSha,
      sizeBytes: info.output.sizeBytes,
    },
    `built tracking model ${entry.id} (local export, inputs pinned)`,
  );
}

/**
 * The multi-step install. Called by
 * `DependencyManager.runCustomInstaller` when it sees the
 * `__TRACKING_PYENV_INSTALL__` sentinel command.
 */
export async function runTrackingPyenvInstall(): Promise<void> {
  const proj = sidecarProjectDir();
  const modelsDir = trackingModelsDir();

  // 1. uv sync the sidecar project. cwd-based invocation — the
  //    `--project <abs>` form was found unreliable in Task 9 (resolves
  //    relative to caller cwd). Mirror that here.
  //
  //    UV_PROJECT_ENVIRONMENT (set by buildUvEnv) is what keeps the ~1.2 GB
  //    venv OUT of `<proj>/.venv`. That default put it inside the signed
  //    `.app`, breaking the code signature and failing on a read-only
  //    install. With the env set, `proj` is only ever READ from (pyproject +
  //    uv.lock), so the package directory stays read-only — verified against
  //    a `chmod 555` project dir.
  const venv = trackingVenvDir();
  logger.info(
    { tag: "tracking-pyenv", op: "uv_sync_start", proj, venv, uv: uvPath() },
    "uv sync of tracking sidecar",
  );
  // `--locked` asserts the shipped uv.lock is already up to date with
  // pyproject.toml. Without it uv may REWRITE uv.lock — another write into the
  // read-only package. It also turns "someone edited pyproject.toml without
  // re-running `uv lock`" into a loud install-time error instead of a silent
  // drift between the lockfile we ship and the env we build.
  await pexec(uvPath(), ["sync", "--locked"], {
    cwd: proj,
    timeout: 10 * 60_000, // first sync resolves torch + boxmot + opencv
    maxBuffer: 32 * 1024 * 1024,
    // buildUvEnv prepends `~/.libi/bin` so uv-spawned subprocesses (python,
    // pip) find the libi-managed binaries, and pins every uv state location
    // under LIBI_HOME. In a packaged Electron app, bootstrapPath() has
    // already augmented PATH for Homebrew etc., which is inherited here.
    env: buildUvEnv({ UV_PROJECT_ENVIRONMENT: venv, NO_COLOR: "1" }),
  });
  logger.info(
    { tag: "tracking-pyenv", op: "uv_sync_done", proj },
    "uv sync complete",
  );

  // 2. Ensure model artifacts are on disk: sha-pinned direct downloads
  //    first, then any build-at-install exports (which consume the
  //    already-provisioned pinned inputs — e.g. yoloe11.onnx is exported
  //    locally from the yoloe_vp checkpoint; see ensureBuiltModel).
  //
  //    ReID note: there is deliberately NO shipped ReID artifact — on first
  //    use boxmot 19 downloads `osnet_x0_25_msmt17.pt` itself and
  //    libitrack/associate.py runs its PyTorch backend directly (best-effort,
  //    motion-only fallback when offline).
  const manifest = readModelsManifest();
  for (const entry of manifest.filter((e) => e.acquisition === "direct-download")) {
    await ensureModel(entry, modelsDir);
  }
  for (const entry of manifest.filter((e) => e.acquisition === "build-at-install")) {
    await ensureBuiltModel(entry, manifest, modelsDir);
  }

  // 3. Write the install-token marker so resolveStatus() reports installed.
  writeToken();
  logger.info(
    { tag: "tracking-pyenv", op: "install_done", token: TRACKING_PYENV_TOKEN },
    "tracking-pyenv install complete",
  );
}

/**
 * `CustomInstaller` registered under id `"tracking-pyenv"`.
 *
 * `verify()` → returns the models dir path iff the token marker is present
 * AND matches the current token. (We don't re-hash every model on every
 * boot — the token is the cheap re-install lever, same convention as
 * BundledDependency.pinnedInstallToken.)
 *
 * `install` → sentinel command; the real work is `runTrackingPyenvInstall`.
 */
export const trackingPyenvInstaller: CustomInstaller & {
  install: { command: string; args: string[]; timeoutMs?: number };
} = {
  verify: async () => {
    const marker = readToken();
    if (marker === TRACKING_PYENV_TOKEN) {
      return trackingModelsDir();
    }
    return null;
  },
  install: {
    command: TRACKING_PYENV_SENTINEL,
    args: [],
    // uv sync (cold torch/boxmot) + model downloads (incl. the 572MB
    // mobileclip export input) + the local yoloe11 ONNX export.
    timeoutMs: 30 * 60_000,
  },
};

/** Direct entry point for the dev dry-run / scripts. */
export async function install(): Promise<void> {
  await runTrackingPyenvInstall();
}
