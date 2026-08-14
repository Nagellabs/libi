import { spawn } from "child_process";
import {
  ANALYZE_PYTHON_VERSION,
  ANALYZE_WITH_SPECS,
  musicAnalysisEnvSignature,
  MusicAnalyzeError,
} from "@/lib/music/analyze";
import { requireUvBinary } from "@/lib/uv-path";
import { buildUvEnv } from "@/lib/uv-env/spawn-env";
import { formatStderrTail } from "@/lib/music/generate";
import { isTokenCurrent, writeInstallToken } from "@/lib/uv-env/install-token";

const TOKEN_FILE = ".libi-music-analysis.install-token";

export function isMusicAnalysisInstalled(): boolean {
  return isTokenCurrent(TOKEN_FILE, musicAnalysisEnvSignature());
}

export function writeMusicAnalysisToken(): void {
  writeInstallToken(TOKEN_FILE, musicAnalysisEnvSignature());
}

/** One-shot uv prefetch + import smoke test. ~10s on a cold cache, <1s
 *  warm. On success writes the install-token marker. */
export async function installMusicAnalysisDeps(timeoutMs = 5 * 60_000): Promise<void> {
  const uv = requireUvBinary(MusicAnalyzeError, "Music analysis");
  const args = [
    "run",
    "--python",
    ANALYZE_PYTHON_VERSION,
    ...ANALYZE_WITH_SPECS.flatMap((s) => ["--with", s]),
    "python",
    "-c",
    "import librosa, soundfile; print('ok')",
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(uv, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: buildUvEnv(),
      });
    let err = "";
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new MusicAnalyzeError(`install timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", () => {});
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve();
      else reject(new MusicAnalyzeError(`install exited ${code}: ${formatStderrTail(err)}`));
    });
  });
  writeMusicAnalysisToken();
}
