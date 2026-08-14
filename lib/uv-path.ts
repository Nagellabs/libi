import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { getLibiBinDir } from "@/lib/libi-home";

/**
 * Resolve the `uv` binary path with the same policy as `resolveStatus`
 * + `installYtDlpViaUv` in `mcp/registry/dependency-manager.ts`:
 *
 *   1. `<libi-bin-dir>/uv` — preferred (libi's own install via Category A)
 *   2. system PATH (`which uv` / `where uv`) — covers cases where Category A
 *      already treats a PATH-resolved uv as "installed" (e.g. Homebrew)
 *
 * Returns the resolved absolute path, or `null` if neither exists. Callers
 * throw their own typed error so the user sees a domain-specific message
 * (Whisper / Kokoro / ACE-Step), but the resolution policy is shared so
 * the three runners can't drift apart.
 */
export function resolveUvBinary(): string | null {
  const bundled = path.join(
    getLibiBinDir(),
    process.platform === "win32" ? "uv.exe" : "uv",
  );
  if (fs.existsSync(bundled)) return bundled;

  const lookup = process.platform === "win32" ? "where" : "which";
  try {
    const stdout = execFileSync(lookup, ["uv"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const candidate = stdout.split("\n")[0]?.trim();
    if (candidate && fs.existsSync(candidate)) return candidate;
  } catch {
    /* uv not on PATH */
  }

  return null;
}

/**
 * Convenience wrapper for callers that prefer to throw. Pass a domain-specific
 * Error constructor so the user sees "Whisper requires…" / "Local TTS
 * requires…" / "Local music requires…" rather than a generic message.
 */
export function requireUvBinary(
  ErrorCtor: new (message: string) => Error,
  featureLabel: string,
): string {
  const uv = resolveUvBinary();
  if (uv) return uv;
  const expected = path.join(
    getLibiBinDir(),
    process.platform === "win32" ? "uv.exe" : "uv",
  );
  throw new ErrorCtor(
    `uv not found at ${expected} or on PATH. ${featureLabel} requires the bundled uv (tier-1 dep).`,
  );
}
