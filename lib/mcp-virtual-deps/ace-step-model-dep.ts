import type { VirtualDep } from "./types";
import {
  isAceStepModelInstalled,
  ACESTEP_DOWNLOAD_SIZE_HUMAN,
} from "@/lib/music/models";
import { getJobManager } from "@/lib/jobs/manager";
import { isInstalling } from "./in-flight";

/** ACE-Step weights (~8.3 GB HF snapshot) gated as a Settings chip.
 *
 *  Re-uses the existing `music_model_download` JobManager runner so the
 *  chip shares progress plumbing (bytesDownloaded/bytesTotal + cancel)
 *  with `libi.install_music_model`. We're in-process here — the
 *  DependencyManager invokes us from the Next.js route — so we call
 *  `getJobManager()` directly rather than going through the HTTP
 *  `runJobViaServer` shim used by MCP-child tools. */
export const aceStepModelVirtualDep: VirtualDep = {
  id: "ace-step-model",
  label: `ace-step weights (${ACESTEP_DOWNLOAD_SIZE_HUMAN})`,
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
    const installed = isAceStepModelInstalled();
    return {
      binary: this.label,
      installed,
      path: null,
      source: installed ? "bundled" : null,
      runtimeStatus: installed ? "installed" : "pending",
      error: null,
    };
  },
  async install() {
    const mgr = getJobManager();
    const result = await mgr.enqueue("music_model_download", { force: false });
    if (result.status === "matching_completed") return;
    await mgr.runToCompletion(result.jobId);
  },
};
