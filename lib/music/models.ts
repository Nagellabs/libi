import fs from "fs";
import path from "path";
import { getLibiModelsDir } from "@/lib/libi-home";

/** ACE-Step git revision (SHA on github.com/ace-step/ACE-Step) — frozen by
 *  the gated Layer-2 E2E (LIBI_MUSIC_E2E=1). Bump only if that test fails
 *  on dependency resolution / breaking API change.
 *
 *  Why git+ and not PyPI: the PyPI sdist for ace-step==0.1.0 has a broken
 *  setup.py that references a requirements.txt not bundled in the tarball,
 *  so `pip install ace-step` fails at the build stage. Upstream hasn't
 *  cut a wheel. Pinning a git SHA gives reproducible installs while we wait.
 *
 *  Source: https://github.com/ace-step/ACE-Step  (Apache-2.0)
 *  Model weights: https://huggingface.co/ACE-Step/ACE-Step-v1-3.5B  (Apache-2.0)
 *
 *  NOTE on naming: PyPI / setup.py name is `ace-step` (with hyphen), but
 *  the installed Python package is `acestep` (no hyphen). The
 *  ACESTEP_RUN_PREFIX in lib/music/generate.ts uses the hyphenated form for
 *  the install spec; the imports in mcp/music/generate.py use the
 *  un-hyphenated form (`from acestep.pipeline_ace_step …`). */
export const ACESTEP_GIT_REPO = "https://github.com/ace-step/ACE-Step.git";
export const ACESTEP_GIT_SHA = "1bee4c9f5b43e30995f8d4d33b3919197ce1bd68";
/** Human-readable label used in agent install banners + error messages.
 *  Bump whenever ACESTEP_GIT_SHA changes. */
export const ACESTEP_VERSION = `git+${ACESTEP_GIT_SHA.slice(0, 7)}`;
export const ACESTEP_MODEL_REPO = "ACE-Step/ACE-Step-v1-3.5B";

/** The pinnedInstallToken value. Bump (new libi release) to force every
 *  user to re-fetch a newer model on next use — surfaced via the
 *  dependency-manager's existing .install-token mismatch path. */
export const ACESTEP_MODEL_VERSION = "v1-3.5B-2026-05-19";

/**
 * MEASURED total of the snapshot this repo pulls, in bytes — not an estimate.
 * Summed from a completed install on 2026-08-17:
 *
 *   6,611,422,728  ace_step_transformer/diffusion_pytorch_model.safetensors
 *   1,127,460,248  umt5-base/model.safetensors
 *     313,646,516  music_dcae_f8c8/diffusion_pytorch_model.safetensors
 *     206,350,988  music_vocoder/diffusion_pytorch_model.safetensors
 *      16,837,459  umt5-base/tokenizer.json
 *         + configs/tokenizers
 *
 * Used as the denominator for byte progress (see `trackDirectoryBytes`). It is a
 * constant rather than an HF API lookup because the snapshot is pinned by
 * `ACESTEP_MODEL_VERSION` — the bytes cannot move without that token moving too.
 * Re-measure and bump both together.
 *
 * Exact to within a few bytes, not to the byte: huggingface_hub also leaves ~1.3 KB
 * of download metadata under `.cache/`, and that varies slightly between installs
 * (measured: a 1-byte difference across two re-downloads of the same files). The
 * progress tracker clamps to this total and the job's completion is gated on the
 * file checks in `missingAceStepModelFiles`, not on hitting the number, so the
 * drift is cosmetic.
 */
export const ACESTEP_DOWNLOAD_BYTES = 8_275_792_188;

/**
 * Shown to the user before they consent to the download, so it has to be right.
 * Was "~5.5 GB" — understating the real pull by ~2.8 GB. The 5.5 GB figure is
 * the commonly-quoted size of the 3.5B checkpoint alone; the snapshot also
 * carries the umt5 text encoder, the DCAE, and the vocoder.
 */
export const ACESTEP_DOWNLOAD_SIZE_HUMAN = "~8.3 GB";

export interface AceStepFile {
  /** Path relative to the model dir (dependency-manager parity). */
  relPath: string;
  /** Real HF resolve URL — detection/parity only; ACE-Step's own
   *  downloader fetches the weights, we never Node-fetch these. */
  url: string;
}

/** Principal files our HF snapshot_download writes under the model dir.
 *  Used for presence detection — `isAceStepModelInstalled()` walks this
 *  list and checks each file is on disk. Paths match the HuggingFace
 *  repo layout (`huggingface.co/ACE-Step/ACE-Step-v1-3.5B/tree/main`)
 *  exactly, because we pass `local_dir=<dir>` to snapshot_download which
 *  mirrors the repo structure verbatim under the dir.
 *
 *  NOTE: this is the principal-files subset, not the full repo. We
 *  intentionally don't list every tokenizer/config — those download
 *  along with the weights via snapshot_download's `allow_patterns`. The
 *  three .safetensors below are the heavy ones; their presence is a
 *  reliable installed-or-not signal. */
export const ACESTEP_FILES: AceStepFile[] = [
  {
    relPath: "config.json",
    url: `https://huggingface.co/${ACESTEP_MODEL_REPO}/resolve/main/config.json`,
  },
  {
    relPath: "ace_step_transformer/diffusion_pytorch_model.safetensors",
    url: `https://huggingface.co/${ACESTEP_MODEL_REPO}/resolve/main/ace_step_transformer/diffusion_pytorch_model.safetensors`,
  },
  {
    // Upstream repo subdir is `music_dcae_f8c8` — _f8c8 is the DCAE variant
    // suffix. Previous releases of this catalog said `music_dcae/` (no
    // suffix); that path doesn't exist in the repo and detection was
    // always false-negative. Verified via the HF model API.
    relPath: "music_dcae_f8c8/diffusion_pytorch_model.safetensors",
    url: `https://huggingface.co/${ACESTEP_MODEL_REPO}/resolve/main/music_dcae_f8c8/diffusion_pytorch_model.safetensors`,
  },
  {
    relPath: "music_vocoder/diffusion_pytorch_model.safetensors",
    url: `https://huggingface.co/${ACESTEP_MODEL_REPO}/resolve/main/music_vocoder/diffusion_pytorch_model.safetensors`,
  },
  {
    relPath: "umt5-base/model.safetensors",
    url: `https://huggingface.co/${ACESTEP_MODEL_REPO}/resolve/main/umt5-base/model.safetensors`,
  },
];

export const DEFAULT_DURATION_SECONDS = 30;
export const MAX_DURATION_SECONDS = 240;
/** Estimated generation time above which the tool asks the agent to
 *  confirm with the user before enqueuing (spec: ETA + approval). */
export const CONFIRM_THRESHOLD_SECONDS = 60;

export interface MusicStyle {
  id: string;
  label: string;
}

/** Curated prompt-hint catalog. Not a model constraint — `prompt` is
 *  free text; these are suggestions the agent can surface. */
export const MUSIC_STYLES: MusicStyle[] = [
  { id: "lofi-hiphop", label: "Lo-fi hip-hop" },
  { id: "cinematic", label: "Cinematic / trailer" },
  { id: "ambient", label: "Ambient / calm" },
  { id: "corporate", label: "Corporate / upbeat" },
  { id: "electronic", label: "Electronic / EDM" },
  { id: "acoustic", label: "Acoustic / folk" },
  { id: "orchestral", label: "Orchestral" },
  { id: "rock", label: "Rock" },
];

export function aceStepModelsDir(): string {
  // MUST equal path.join(getLibiModelsDir(), <bundled dep binary>) so the
  // dependency-manager's resolveStatus computes the same path.
  return path.join(getLibiModelsDir(), "ace-step");
}

export function aceStepModelFilePaths(): string[] {
  const dir = aceStepModelsDir();
  return ACESTEP_FILES.map((f) => path.join(dir, f.relPath));
}

export function installTokenPath(): string {
  // Mirrors dependency-manager getInstallTokenPath for files[] models:
  // path.join(modelsRoot, dep.binary, ".install-token").
  return path.join(aceStepModelsDir(), ".install-token");
}

export function readInstalledToken(): string | null {
  try {
    return fs.readFileSync(installTokenPath(), "utf-8").trim();
  } catch {
    return null;
  }
}

export function writeInstalledToken(token: string): void {
  fs.mkdirSync(aceStepModelsDir(), { recursive: true });
  fs.writeFileSync(installTokenPath(), token, "utf-8");
}

/** Principal files that are absent or zero-length, as paths relative to the
 *  model dir. Empty ⇒ the weights are all on disk.
 *
 *  Exists so the download runner can VERIFY before it declares success: a
 *  `uv` exit code of 0 is not evidence the snapshot landed, and writing the
 *  install token on that assumption produced a `completed` job with no model
 *  behind it. Deliberately reports WHICH files are missing — "download
 *  failed" sends the user back to an 8.3 GB retry with nothing to act on. */
export function missingAceStepModelFiles(): string[] {
  const dir = aceStepModelsDir();
  return ACESTEP_FILES.filter((f) => {
    try {
      return fs.statSync(path.join(dir, f.relPath)).size === 0;
    } catch {
      return true;
    }
  }).map((f) => f.relPath);
}

/** Installed = every principal file present non-empty AND the marker
 *  equals the pinned model version (version-aware — the convergence). */
export function isAceStepModelInstalled(): boolean {
  try {
    const filesOk = aceStepModelFilePaths().every(
      (p) => fs.statSync(p).size > 0,
    );
    return filesOk && readInstalledToken() === ACESTEP_MODEL_VERSION;
  } catch {
    return false;
  }
}

/** Rough wall-clock estimate. Apple Silicon (MPS) is ~0.6x audio
 *  seconds; other CPUs ~12x. Used to decide the confirm gate; the real
 *  job is cancellable regardless. */
export function estimateGenerationSeconds(durationSeconds: number): number {
  const appleSilicon =
    process.platform === "darwin" && process.arch === "arm64";
  const factor = appleSilicon ? 0.6 : 12;
  return Math.ceil(durationSeconds * factor) + 8; // +cold model load
}

export function listMusicStatus(): {
  modelInstalled: boolean;
  downloadSizeHuman: string;
  defaultDurationSeconds: number;
  maxDurationSeconds: number;
  styles: MusicStyle[];
} {
  return {
    modelInstalled: isAceStepModelInstalled(),
    downloadSizeHuman: ACESTEP_DOWNLOAD_SIZE_HUMAN,
    defaultDurationSeconds: DEFAULT_DURATION_SECONDS,
    maxDurationSeconds: MAX_DURATION_SECONDS,
    styles: MUSIC_STYLES,
  };
}
