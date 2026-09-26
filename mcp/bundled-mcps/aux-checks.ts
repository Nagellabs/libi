import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { isWindows } from "@/lib/platform";
import {
  checkYtDlpLauncher,
  VIDEO_DOWNLOAD_UI_PATH,
  type YtDlpLauncherHealth,
} from "@/lib/video-download/launcher";

const execFileAsync = promisify(execFile);

async function resolveOnPath(name: string): Promise<string | null> {
  const pathEnv = process.env.PATH || "";
  const sep = isWindows() ? ";" : ":";
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      await fsp.access(candidate, fsp.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export interface AuxResult {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Verify a binary exists on PATH and runs. Spawns `<binary> --version`
 * with a 3-second timeout — fast enough not to block diagnose, slow
 * enough to give a slow binary (e.g. PyInstaller cold-start) a chance.
 */
export async function checkBinary(name: string): Promise<AuxResult> {
  const start = Date.now();
  try {
    const { stdout } = await execFileAsync(name, ["--version"], { timeout: 3000, windowsHide: true });
    const ms = Date.now() - start;
    const version = stdout.split("\n")[0].trim();
    const resolved = await resolveOnPath(name);
    const pathPart = resolved ?? name;
    const versionPart = version || "ran ok";
    return { name, ok: true, detail: `${pathPart} — ${versionPart} (${ms}ms cold start)` };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { signal?: string; killed?: boolean };
    if (e.code === "ENOENT") {
      return { name, ok: false, detail: `${name} not found on PATH` };
    }
    if (e.signal === "SIGTERM" || e.killed) {
      return { name, ok: false, detail: `${name} timed out after 3s — startup too slow` };
    }
    return { name, ok: false, detail: `${name} failed: ${e.message}` };
  }
}

/** Plain words for a launcher that is not usable, per `checkYtDlpLauncher`'s reason. */
function launcherProblem(health: Extract<YtDlpLauncherHealth, { ok: false }>): string {
  const fix = `libi repairs it on the next video download, or use Download / Re-download at ${VIDEO_DOWNLOAD_UI_PATH}.`;
  switch (health.reason) {
    case "missing":
      return `not installed yet (no ${health.launcher}) — ${fix}`;
    case "unrecognised":
      return `${health.launcher} is not a launcher libi wrote — ${fix}`;
    case "target_missing":
      return `${health.launcher} runs ${health.target}, which no longer exists — ${fix}`;
    case "interpreter_missing":
      return `the Python behind ${health.target} is gone — ${fix}`;
  }
}

/**
 * libi's yt-dlp, judged the way the installer and the download job judge it:
 * the launcher libi wrote into `<LIBI_HOME>/bin` and the entry point it runs
 * (`checkYtDlpLauncher`). `checkBinary("yt-dlp")` used to stand in for this and
 * was wrong twice over — it found whichever yt-dlp was first on the MCP
 * child's PATH, and on Windows, where the launcher is `yt-dlp.cmd`, `execFile`
 * cannot run it without a shell, so it always said "not found on PATH". When
 * the launcher is healthy the entry point itself (a script with a shebang, or
 * the `.exe` trampoline on Windows — both run without a shell) answers
 * `--version`, bounded like `checkBinary`.
 */
export async function checkYtDlp(
  check: () => YtDlpLauncherHealth = checkYtDlpLauncher,
): Promise<AuxResult> {
  const name = "yt-dlp";
  const health = check();
  if (!health.ok) return { name, ok: false, detail: launcherProblem(health) };
  const start = Date.now();
  try {
    const { stdout } = await execFileAsync(health.target, ["--version"], {
      timeout: 3000,
      windowsHide: true,
    });
    const version = String(stdout).split("\n")[0].trim() || "ran ok";
    return {
      name,
      ok: true,
      detail: `${health.launcher} → ${health.target} — ${version} (${Date.now() - start}ms cold start)`,
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { signal?: string; killed?: boolean };
    if (e.signal === "SIGTERM" || e.killed) {
      return { name, ok: false, detail: `${health.target} timed out after 3s — startup too slow` };
    }
    return { name, ok: false, detail: `${health.target} failed to run: ${e.message}` };
  }
}
