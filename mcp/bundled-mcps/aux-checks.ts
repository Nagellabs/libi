import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { isWindows } from "@/lib/platform";

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

/**
 * Check whether an env var is present in the row's `envVars` JSON.
 * Reports ok / not-ok WITHOUT leaking the value — critical for API keys.
 */
export function checkEnvVar(
  row: { envVars: string | null | undefined },
  key: string,
): AuxResult {
  if (!row.envVars) return { name: key, ok: false, detail: "missing from row.envVars" };
  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(row.envVars);
  } catch {
    return { name: key, ok: false, detail: "row.envVars is malformed JSON" };
  }
  const value = parsed[key];
  if (!value || value === "") {
    return { name: key, ok: false, detail: "missing — ask user to provide" };
  }
  return { name: key, ok: true, detail: "set" };
}
