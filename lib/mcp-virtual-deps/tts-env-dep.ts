import type { VirtualDep } from "./types";
import { spawn } from "child_process";
import {
  isTtsEnvCurrent,
  writeTtsEnvToken,
  TTS_PYTHON_VERSION,
  TTS_WITH_SPECS,
} from "@/lib/tts/synthesize";
import { requireUvBinary } from "@/lib/uv-path";
import { buildUvEnv } from "@/lib/uv-env/spawn-env";
import { isInstalling } from "./in-flight";

class TtsEnvInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TtsEnvInstallError";
  }
}

export const ttsEnvVirtualDep: VirtualDep = {
  id: "tts-env",
  label: "kokoro env (kokoro-onnx)",
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
    const installed = isTtsEnvCurrent();
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
    // One-shot uv prefetch + import smoke test. Mirrors
    // lib/mcp-virtual-deps/whisper-env-dep.ts. Writes the env token
    // on success so the next synthesize call skips needs_install.
    const uv = requireUvBinary(TtsEnvInstallError, "Kokoro TTS");
    const args = [
      "run",
      "--python",
      TTS_PYTHON_VERSION,
      ...TTS_WITH_SPECS.flatMap((s) => ["--with", s]),
      "python",
      "-c",
      "import kokoro_onnx, soundfile; print('ok')",
    ];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(uv, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: buildUvEnv(),
      });
      let err = "";
      const t = setTimeout(
        () => {
          child.kill("SIGKILL");
          reject(new TtsEnvInstallError("install timed out after 5 minutes"));
        },
        5 * 60_000,
      );
      child.stdout.on("data", () => {});
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("close", (code) => {
        clearTimeout(t);
        if (code === 0) resolve();
        else
          reject(
            new TtsEnvInstallError(
              `install exited ${code}: ${err.trim().slice(-2000)}`,
            ),
          );
      });
    });
    writeTtsEnvToken();
  },
};
