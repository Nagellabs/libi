import { z } from "zod/v3";
import { trackingEngineInstalled } from "@/lib/tracking/not-installed";
import { trackingModelsDir } from "@/lib/tracking/engine-deps";
import { trackingVenvDir } from "@/lib/uv-env/spawn-env";
import { isTestMode } from "@/lib/test-mode";
import { trackDirectoryBytes } from "@/lib/jobs/dir-download-progress";
import { DependencyManager } from "@/mcp/registry/dependency-manager";
import type { JobContext, JobRunner } from "@/lib/jobs/types";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";

/** Chat/Settings render `done`/`total` verbatim, so report MB rather than raw
 *  bytes — matches `whisper_model_download`, `tts_model_download` and
 *  `music_model_download`. */
const BYTES_PER_MB = 1_000_000;

/** The tracking-pyenv install has no single manifest to sum for an exact
 *  expected size — it is `uv sync` (torch/boxmot/onnxruntime wheels into the
 *  venv) plus model provisioning (downloads + a local YOLOE ONNX export whose
 *  build inputs include the 572 MB MobileCLIP encoder). Measured on a real
 *  completed install (macOS arm64, 2026-08): venv ~1.2 GB + models dir
 *  ~788 MB ≈ 2.0 GB. `trackDirectoryBytes` clamps at the total, so an install
 *  that lands smaller simply pins at <100% until the final report; one that
 *  lands larger never renders "104%". */
const ESTIMATED_TOTAL_BYTES = 2_000_000_000;

/** These two strings come verbatim from `mcp/registry/bundled.ts`: the
 *  `libi-tracking` server's single dependency, `binary: "tracking-pyenv"`
 *  with `customInstallerId: "tracking-pyenv"`. */
const TRACKING_MCP_ID = "libi-tracking";
const TRACKING_DEP_BINARY = "tracking-pyenv";

// NO params on purpose: there is exactly one tracking engine to install, so
// one empty object means one paramsHash — every concurrent "install it"
// request dedupes onto the same job. Never add transient values here
// (toolCallId, timestamps); they would break that dedupe.
const paramsSchema = z.object({});

export type TrackingEngineInstallParams = z.infer<typeof paramsSchema>;

export interface TrackingEngineInstallResult {
  alreadyInstalled: boolean;
}

export const trackingEngineInstallRunner: JobRunner<
  TrackingEngineInstallParams,
  TrackingEngineInstallResult
> = {
  kind: "tracking_engine_install",
  mcpToolId: makeMcpToolId("libi", "libi.install_tracking_engine"),
  maxConcurrent: 1,
  paramsSchema,
  // `uv sync` has no clean midpoint — a half-synced venv is not resumable
  // state we can checkpoint; restart from scratch on retry (uv's own cache
  // makes the retry cheap anyway).
  resumable: false,
  // uv sync (cold torch/boxmot wheels) and the 572 MB MobileCLIP download
  // both run silent for minutes; a progress timeout would kill a healthy run.
  noProgressTimeoutMs: null,
  async run(
    ctx: JobContext<TrackingEngineInstallParams>,
  ): Promise<TrackingEngineInstallResult> {
    if (trackingEngineInstalled()) {
      ctx.reportProgress(1, 1, "step");
      return { alreadyInstalled: true };
    }
    // Refuse under LIBI_TEST_MODE. Test mode fakes the fal-ai/ElevenLabs
    // MCPs, but it fakes NOTHING about this install — there are no test-mode
    // branches anywhere under mcp/registry/, lib/tracking/ or lib/uv-env/
    // (verified 2026-08-22). Without this guard, a skill-eval scenario that
    // wanders into libi.install_tracking_engine silently spends 10–20 minutes
    // and ~2 GB of real downloads into a throwaway LIBI_HOME the harness
    // deletes afterwards. Fail loudly instead.
    if (isTestMode()) {
      throw new Error(
        "Refusing to install the tracking engine in test mode: this is a real " +
          "~2 GB, 10–20 minute uv sync + model provisioning run, and " +
          "LIBI_TEST_MODE=1 fakes nothing about it. Run the install outside " +
          "test mode.",
      );
    }
    // The installer emits no progress callbacks — only tagged logs
    // (tracking-pyenv) — so watch the destination directories grow, exactly
    // as whisper_model_download does. Two directories take the bytes: the
    // uv-managed venv (torch/boxmot/onnxruntime wheels) and the models dir
    // (ONNX artifacts + the YOLOE export's build inputs).
    const totalMb = Math.max(
      1,
      Math.floor(ESTIMATED_TOTAL_BYTES / BYTES_PER_MB),
    );
    ctx.reportProgress(0, totalMb, "MB");
    const progress = trackDirectoryBytes({
      dir: [trackingVenvDir(), trackingModelsDir()],
      totalBytes: ESTIMATED_TOTAL_BYTES,
      onBytes: (bytesDone) => {
        ctx.reportProgress(
          Math.min(Math.floor(bytesDone / BYTES_PER_MB), totalMb),
          totalMb,
          "MB",
        );
      },
    });
    try {
      // retryDep — not runCustomInstaller directly — on purpose: it writes
      // the same dependencyStatus transitions (installing → installed /
      // failed) the Settings UI polls, so the agent path and the human
      // Settings path stay one and the same install, observable in both
      // places.
      await new DependencyManager().retryDep(
        TRACKING_MCP_ID,
        TRACKING_DEP_BINARY,
      );
    } finally {
      progress.stop();
    }
    if (ctx.shouldCancel()) throw new Error("cancelled");
    // VERIFY BEFORE DECLARING SUCCESS — the whisper/music defect-#59 lesson:
    // `retryDep` resolving only means the installer chain exited without
    // throwing, which is not evidence the engine is installed. The installer
    // writes the .install-token marker itself, last, on its own — never write
    // it here. If the marker is absent the install did NOT complete, and a
    // `completed` job would surface much later as an opaque tracking error.
    if (!trackingEngineInstalled()) {
      throw new Error(
        "Tracking engine install finished but the install token is missing " +
          `under ${trackingModelsDir()}. The engine is NOT installed.`,
      );
    }
    ctx.reportProgress(totalMb, totalMb, "MB");
    return { alreadyInstalled: false };
  },
};
