import type { VirtualDep } from "./types";
import {
  isMusicAnalysisInstalled,
  installMusicAnalysisDeps,
} from "@/lib/music/analyze-install";
import { isInstalling } from "./in-flight";

export const musicAnalysisEnvVirtualDep: VirtualDep = {
  id: "music-analysis-env",
  label: "librosa env (~50 MB)",
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
    const installed = isMusicAnalysisInstalled();
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
    await installMusicAnalysisDeps();
  },
};
