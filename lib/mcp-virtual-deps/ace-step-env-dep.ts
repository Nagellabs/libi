import type { VirtualDep } from "./types";
import { isAceStepEnvCurrent, generateMusic } from "@/lib/music/generate";
import { isInstalling } from "./in-flight";

/** ACE-Step uv-env warm-up gated as a Settings chip.
 *
 *  "Installing" the env IS running the subprocess once: uv resolves the
 *  spec, fetches wheels, and on the first successful WAV emit
 *  `generateMusic` writes the env install-token via
 *  `writeAceStepEnvToken()`. We use a tiny 1-second instrumental as the
 *  warmup payload.
 *
 *  NOTE on chip ordering: this warmup invokes the ACE-Step subprocess
 *  which needs the model weights on disk. If the user clicks Install on
 *  the env chip before the model chip is `installed`, the underlying
 *  `generateMusic` call will fail at model-load. The Settings UI shows
 *  both chips together; install them in order (model → env). */
export const aceStepEnvVirtualDep: VirtualDep = {
  id: "ace-step-env",
  label: "ace-step env",
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
    const installed = isAceStepEnvCurrent();
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
    await generateMusic({
      prompt: "warmup",
      durationSeconds: 1,
      instrumental: true,
      seed: 0,
    });
  },
};
