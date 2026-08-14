import { accessSync, constants } from "node:fs";
import path from "node:path";

/**
 * Locating the Claude native CLI binary inside a runtime agent install root.
 *
 * WHY THIS EXISTS — the partial-install trap:
 *
 * `@agentclientprotocol/claude-agent-acp` (~40KB of JS) depends on
 * `@anthropic-ai/claude-agent-sdk`, whose actual ~212MB CLI binary arrives as
 * a PLATFORM-SPECIFIC **optionalDependency** (`@anthropic-ai/claude-agent-sdk-
 * <platform>-<arch>`). npm **exits 0 when an optional dependency fails to
 * install** — so a network blip mid-download, a full disk, a proxy timeout on
 * the large tarball, or a force-quit during the install all leave a tree where
 * `.bin/claude-agent-acp` exists and the adapter's own version matches the pin,
 * while the binary it must exec is simply absent. Verifying "did the adapter
 * install?" therefore proves nothing; only the platform package's presence does.
 *
 * The failure is otherwise invisible until the FIRST `session/new`, where the
 * adapter throws `Claude native binary not found for <platform>-<arch>`.
 *
 * RESOLUTION LOGIC mirrors the adapter's own `claudeCliPath()` in
 * `node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js`:
 *   - `CLAUDE_CODE_EXECUTABLE` wins outright, before any package lookup.
 *   - Candidate package name is `@anthropic-ai/claude-agent-sdk-<platform>-<arch>`,
 *     holding `claude` (`claude.exe` on win32).
 *   - On linux BOTH glibc and musl variants can be installed side by side, so
 *     the runtime libc decides the preference order and the other is only a
 *     fallback — picking the wrong one segfaults instead of failing to spawn.
 *
 * It differs in HOW it resolves: the adapter uses a `createRequire` bound to
 * the SDK, which only works from a process that can resolve the SDK. libi
 * verifies an install root it does not import from, so this walks the npm
 * layouts that root can produce (hoisted + the two nested fallbacks npm uses
 * when hoisting is blocked). Each probe is a single `accessSync`, so a healthy
 * check is a handful of stats — cheap enough for the boot hot path.
 */

/** Package name of the platform-specific SDK bundle holding the CLI binary. */
export const SDK_PLATFORM_PACKAGE_PREFIX = "@anthropic-ai/claude-agent-sdk";

export interface NativeBinaryProbe {
  /** Defaults to `process.platform`. A parameter so tests can fake a platform. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.arch`. */
  arch?: string;
  /** Defaults to runtime libc detection; only consulted on linux. */
  musl?: boolean;
  /**
   * Defaults to `process.env` — read for the `CLAUDE_CODE_EXECUTABLE` override.
   * Typed as a plain record (not `NodeJS.ProcessEnv`, whose repo-wide
   * augmentation makes some keys required) so tests can pass `{}`.
   */
  env?: Record<string, string | undefined>;
}

/**
 * `process.report.getReport().header.glibcVersionRuntime` is populated when
 * Node is dynamically linked against glibc, and absent on musl. Same probe the
 * adapter uses, so both agree on which linux variant is "the" right one.
 */
export function isMuslLibc(): boolean {
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  return !report?.header?.glibcVersionRuntime;
}

/**
 * Platform packages that could hold this runtime's CLI binary, in preference
 * order (see the linux note above). Pure — exported for tests.
 */
export function claudePlatformPackageNames(probe: NativeBinaryProbe = {}): string[] {
  const platform = probe.platform ?? process.platform;
  const arch = probe.arch ?? process.arch;
  if (platform !== "linux") {
    return [`${SDK_PLATFORM_PACKAGE_PREFIX}-${platform}-${arch}`];
  }
  const musl = probe.musl ?? isMuslLibc();
  const glibcPkg = `${SDK_PLATFORM_PACKAGE_PREFIX}-linux-${arch}`;
  const muslPkg = `${glibcPkg}-musl`;
  return musl ? [muslPkg, glibcPkg] : [glibcPkg, muslPkg];
}

/**
 * `node_modules` directories under `root` that npm can place the platform
 * package in: hoisted to the root first (the overwhelmingly common case),
 * then nested under the adapter or the SDK when hoisting is blocked by a
 * conflicting version already at the top level.
 */
function candidateNodeModulesDirs(root: string): string[] {
  const top = path.join(root, "node_modules");
  return [
    top,
    path.join(top, "@agentclientprotocol", "claude-agent-acp", "node_modules"),
    path.join(top, "@anthropic-ai", "claude-agent-sdk", "node_modules"),
    path.join(
      top,
      "@agentclientprotocol",
      "claude-agent-acp",
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk",
      "node_modules",
    ),
  ];
}

/** Every path the CLI binary could occupy under `root`, in preference order. */
export function claudeNativeBinaryCandidates(
  root: string,
  probe: NativeBinaryProbe = {},
): string[] {
  const platform = probe.platform ?? process.platform;
  const file = platform === "win32" ? "claude.exe" : "claude";
  const packages = claudePlatformPackageNames(probe);
  const dirs = candidateNodeModulesDirs(root);
  const out: string[] = [];
  // Package preference (glibc vs musl) outranks layout: a correct binary in a
  // nested layout beats the wrong-libc one hoisted at the top.
  for (const pkg of packages) {
    for (const dir of dirs) {
      out.push(path.join(dir, ...pkg.split("/"), file));
    }
  }
  return out;
}

function isReadableFile(file: string, platform: NodeJS.Platform): boolean {
  try {
    // Node maps X_OK to F_OK on Windows, so asking for it there is misleading
    // noise rather than a check — ask for what the platform can actually answer.
    accessSync(file, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute path to the Claude CLI binary usable from `root`, or null.
 *
 * Returns the `CLAUDE_CODE_EXECUTABLE` override verbatim when set, because
 * that is exactly what the adapter will exec — a user who points it at their
 * own Claude Code install has a working setup with no platform package at all,
 * and must not be told the install is broken.
 */
export function resolveClaudeNativeBinary(
  root: string,
  probe: NativeBinaryProbe = {},
): string | null {
  const env = probe.env ?? process.env;
  const override = env.CLAUDE_CODE_EXECUTABLE;
  if (override) return override;

  const platform = probe.platform ?? process.platform;
  for (const candidate of claudeNativeBinaryCandidates(root, probe)) {
    if (isReadableFile(candidate, platform)) return candidate;
  }
  return null;
}

/** True when `root` holds a Claude CLI binary this runtime can actually exec. */
export function claudeNativeBinaryPresent(
  root: string,
  probe: NativeBinaryProbe = {},
): boolean {
  return resolveClaudeNativeBinary(root, probe) !== null;
}

/**
 * The user-facing diagnostic for a tree whose adapter installed but whose
 * platform binary did not. Names the real cause (npm's silent optional-dep
 * failure) and the two recoveries, because "reinstall" alone is not actionable
 * when the install already reported success.
 */
export function claudeNativeBinaryMissingError(
  root: string,
  probe: NativeBinaryProbe = {},
): string {
  const platform = probe.platform ?? process.platform;
  const arch = probe.arch ?? process.arch;
  const [expected] = claudePlatformPackageNames(probe);
  return (
    `the Claude native binary for ${platform}-${arch} is missing from ${root} ` +
    `(${expected} did not install). npm exits 0 when an optional dependency ` +
    `fails, so this is usually an interrupted or blocked download of its ~212MB ` +
    `tarball — check network/proxy access to registry.npmjs.org and free disk ` +
    `space, then restart libi to retry. Alternatively set CLAUDE_CODE_EXECUTABLE ` +
    `to an existing Claude Code binary.`
  );
}
