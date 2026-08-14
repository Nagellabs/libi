import type { VirtualDep } from "./types";
import { spawn } from "child_process";
import {
  isWhisperEnvCurrent,
  writeWhisperEnvToken,
  WHISPER_PYTHON_VERSION,
  WHISPER_WITH_SPECS,
} from "@/lib/whisper/transcribe";
import { requireUvBinary } from "@/lib/uv-path";
import { buildUvEnv } from "@/lib/uv-env/spawn-env";
import { isInstalling } from "./in-flight";

class WhisperEnvInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhisperEnvInstallError";
  }
}

/** Whisper uv-env warm-up gated as a Settings chip.
 *
 *  Unlike ACE-Step (where the warm-up generates a 1s WAV), Whisper's
 *  warm-up does not need any audio input — we just want uv to resolve
 *  the spec, fetch wheels, and confirm faster_whisper can import. On
 *  success we write the env token so the next transcribe call short-
 *  circuits the needs_install branch.
 *
 *  Mirrors the one-shot uv subprocess shape used by
 *  `installMusicAnalysisDeps` in lib/music/analyze-install.ts. */
export const whisperEnvVirtualDep: VirtualDep = {
  id: "whisper-env",
  label: "whisper env (faster-whisper)",
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
    const installed = isWhisperEnvCurrent();
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
    const uv = requireUvBinary(WhisperEnvInstallError, "Whisper");
    const args = [
      "run",
      "--python",
      WHISPER_PYTHON_VERSION,
      ...WHISPER_WITH_SPECS.flatMap((s) => ["--with", s]),
      "python",
      "-c",
      "import faster_whisper; print('ok')",
    ];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(uv, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: buildUvEnv(),
      });
      let err = "";
      const t = setTimeout(
        () => {
          child.kill("SIGKILL");
          reject(
            new WhisperEnvInstallError("install timed out after 5 minutes"),
          );
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
            new WhisperEnvInstallError(
              `install exited ${code}: ${err.trim().slice(-2000)}`,
            ),
          );
      });
    });
    writeWhisperEnvToken();
  },
};
