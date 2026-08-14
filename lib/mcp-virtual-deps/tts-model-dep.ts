import type { VirtualDep } from "./types";
import { isKokoroModelInstalled } from "@/lib/tts/voices";
import { getJobManager } from "@/lib/jobs/manager";
import { isInstalling } from "./in-flight";

export const ttsModelVirtualDep: VirtualDep = {
  id: "tts-model",
  label: "kokoro TTS weights",
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
    const installed = isKokoroModelInstalled();
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
    // In-process JobManager — we're in Next.js.
    const mgr = getJobManager();
    const result = await mgr.enqueue("tts_model_download", {});
    if (result.status === "matching_completed") return;
    await mgr.runToCompletion(result.jobId);
  },
};
