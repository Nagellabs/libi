import type { VirtualDep } from "./types";
import {
  installedWhisperModels,
  whisperModelsDir,
  DEFAULT_WHISPER_MODEL,
} from "@/lib/whisper/models";
import { getJobManager } from "@/lib/jobs/manager";
import { isInstalling } from "./in-flight";

const MODEL = DEFAULT_WHISPER_MODEL;

/** Whisper model weights gated as a Settings chip.
 *
 *  Satisfied by ANY installed catalogue model, not only the default: a user
 *  who installed `tiny` has a working Whisper, and the card must say so. It
 *  used to read "whisper small weights" and stay "Setup required" after a
 *  working `tiny` install (0.1.16 full verification F8). Download still
 *  fetches the default (`small`) — the model the plan proposes.
 *
 *  Re-uses the existing `whisper_model_download` JobManager runner so the
 *  chip shares progress plumbing (bytesDownloaded/bytesTotal + cancel)
 *  with the agent-facing model-install tool. We're in-process here — the
 *  DependencyManager invokes us from the Next.js route — so we call
 *  `getJobManager()` directly rather than going through the HTTP
 *  `runJobViaServer` shim used by MCP-child tools. */
export const whisperModelVirtualDep: VirtualDep = {
  id: "whisper-model",
  label: "a Whisper model",
  async inspect() {
    if (isInstalling(this.id)) {
      return {
        binary: this.label,
        installed: false,
        path: null,
        source: null,
        runtimeStatus: "installing",
        error: null,
      };
    }
    const installed = installedWhisperModels().length > 0;
    return {
      binary: this.label,
      installed,
      path: installed ? whisperModelsDir() : null,
      source: installed ? "bundled" : null,
      runtimeStatus: installed ? "installed" : "pending",
      error: null,
    };
  },
  async install() {
    const mgr = getJobManager();
    const result = await mgr.enqueue("whisper_model_download", {
      model: MODEL,
    });
    // If a matching prior install already completed, the model is on disk —
    // no need to spawn another download.
    if (result.status === "matching_completed") return;
    await mgr.runToCompletion(result.jobId);
  },
};
