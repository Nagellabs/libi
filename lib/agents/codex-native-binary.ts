import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";

/**
 * Locating the Codex engine binary inside an npm tree root.
 *
 * WHY THIS EXISTS — the same partial-install trap as
 * `lib/agents/claude-native-binary.ts`, in codex clothing:
 *
 * `@agentclientprotocol/codex-acp` is ~1MB of adapter JS (`dist/index.js`)
 * whose actual engine — a ~271MB Rust binary — arrives as a PLATFORM-SPECIFIC
 * **optionalDependency** of its `@openai/codex` dependency
 * (`@openai/codex-<platform>-<arch>`). npm exits 0 when an optional dependency
 * fails to install, so a network blip / full disk / proxy timeout on the large
 * tarball leaves `.bin/codex-acp` present while the binary it must spawn is
 * absent. The adapter then dies at the first spawn. Verifying the adapter
 * package proves nothing; only the platform package's binary does.
 *
 * MIGRATION NOTE (2026-08-02): this used to describe
 * `@zed-industries/codex-acp`, which npm now marks deprecated in favour of
 * `@agentclientprotocol/codex-acp`. That is NOT a rename — the engine moved
 * from the adapter's own `@zed-industries/codex-acp-<platform>-<arch>` package
 * (binary at `bin/codex-acp`) to OpenAI's own `@openai/codex-<platform>-<arch>`
 * (binary at `vendor/<rust-target-triple>/bin/codex`). Both the package name
 * and the path shape changed, which is why this file is a rewrite rather than
 * a string swap.
 *
 * NOTE the engine is still EMBEDDED for the ACP path. The adapter derives its
 * codex path as `process.env["CODEX_PATH"]` (undefined by default) and, when
 * that is unset, resolves the BUNDLED `@openai/codex/bin/codex.js` launcher
 * and spawns it — it never falls back to a PATH `codex`. (Its separate
 * `codex-acp login` subcommand does default to `"codex"` on PATH, but libi
 * never invokes that.) So a `codex` on PATH remains neither necessary nor
 * sufficient for the ACP agent to run — see `detectCodex` in
 * `lib/agents/acp/agent-registry.ts`.
 *
 * RESOLUTION LOGIC mirrors the launcher's own lookup
 * (`node_modules/@openai/codex/bin/codex.js`): map platform+arch to a Rust
 * target triple, resolve `@openai/codex-<platform>-<arch>`, and look for
 * `vendor/<triple>/bin/codex` (`codex.exe` on win32). The launcher falls back
 * to `@openai/codex`'s own `vendor/` when the platform package cannot be
 * resolved, so that path is checked too. Like the Claude helper, this walks the
 * npm layouts a root can produce (hoisted + nested) instead of importing from
 * the tree, so it can verify a root the current process doesn't resolve
 * modules from.
 */

/** Package-name prefix of the platform-specific engine bundle. */
export const CODEX_PLATFORM_PACKAGE_PREFIX = "@openai/codex";

/**
 * platform+arch -> Rust target triple, copied from the launcher's
 * PLATFORM_PACKAGE_BY_TARGET switch. Linux uses **musl** triples; getting this
 * wrong yields a path that never exists and a permanently "not installed"
 * agent. There are exactly six, matching @openai/codex's optionalDependencies.
 */
const TARGET_TRIPLE: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};

export interface CodexBinaryProbe {
  /** Defaults to `process.platform`. A parameter so tests can fake a platform. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.arch`. */
  arch?: string;
  /** Defaults to a real `fs.existsSync`. A parameter so tests can fake a tree. */
  exists?: (p: string) => boolean;
}

/** The Rust target triple for this runtime, or null on an unsupported host. */
export function codexTargetTriple(probe: CodexBinaryProbe = {}): string | null {
  const platform = probe.platform ?? process.platform;
  const arch = probe.arch ?? process.arch;
  // The launcher treats android like linux; mirror that.
  const key = `${platform === "android" ? "linux" : platform}-${arch}`;
  return TARGET_TRIPLE[key] ?? null;
}

/** The platform package holding this runtime's engine binary. */
export function codexPlatformPackageName(probe: CodexBinaryProbe = {}): string {
  const platform = probe.platform ?? process.platform;
  const arch = probe.arch ?? process.arch;
  return `${CODEX_PLATFORM_PACKAGE_PREFIX}-${platform === "android" ? "linux" : platform}-${arch}`;
}

/**
 * `node_modules` directories under `root` that npm can place the platform
 * package in: hoisted to the root first (the overwhelmingly common case),
 * then nested under the adapter and under @openai/codex when hoisting is
 * blocked.
 */
function candidateNodeModulesDirs(root: string): string[] {
  const top = path.join(root, "node_modules");
  return [
    top,
    path.join(top, "@agentclientprotocol", "codex-acp", "node_modules"),
    path.join(top, "@openai", "codex", "node_modules"),
  ];
}

/** Every path the engine binary could occupy under `root`, in preference order. */
export function codexNativeBinaryCandidates(
  root: string,
  probe: CodexBinaryProbe = {},
): string[] {
  const platform = probe.platform ?? process.platform;
  const triple = codexTargetTriple(probe);
  if (!triple) return [];
  const file = platform === "win32" ? "codex.exe" : "codex";
  const pkg = codexPlatformPackageName(probe);
  const out: string[] = [];
  for (const dir of candidateNodeModulesDirs(root)) {
    // The platform package's own vendor dir…
    out.push(path.join(dir, ...pkg.split("/"), "vendor", triple, "bin", file));
    // …and the launcher's fallback: @openai/codex/vendor.
    out.push(path.join(dir, "@openai", "codex", "vendor", triple, "bin", file));
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

/** Absolute path to the Codex engine binary usable from `root`, or null. */
export function resolveCodexNativeBinary(
  root: string,
  probe: CodexBinaryProbe = {},
): string | null {
  const platform = probe.platform ?? process.platform;
  for (const candidate of codexNativeBinaryCandidates(root, probe)) {
    if (isReadableFile(candidate, platform)) return candidate;
  }
  return null;
}

/** True when `root` holds a Codex engine binary this runtime can actually spawn. */
export function codexNativeBinaryPresent(
  root: string,
  probe: CodexBinaryProbe = {},
): boolean {
  return resolveCodexNativeBinary(root, probe) !== null;
}

/**
 * The user-facing diagnostic for a tree whose adapter installed but whose
 * platform binary did not. Names the real cause (npm's silent optional-dep
 * failure) and the recovery.
 */
export function codexNativeBinaryMissingError(
  root: string,
  probe: CodexBinaryProbe = {},
): string {
  const platform = probe.platform ?? process.platform;
  const arch = probe.arch ?? process.arch;
  const head =
    `the Codex engine binary for ${platform}-${arch} is missing from ${root} ` +
    `(${codexPlatformPackageName(probe)} did not install). npm exits 0 when an ` +
    `optional dependency fails, so this is usually an interrupted or blocked ` +
    `download of its ~271MB tarball`;

  // "Reinstall libi" is the right advice for an END-USER install, and useless
  // advice in a dev checkout: there, the incomplete tree is the REPO, and the
  // usual cause is a deliberate `npm install --omit=optional`. Telling a
  // contributor to reinstall the app they are developing sends them nowhere —
  // and "restart libi" can never fix it, because nothing on restart installs
  // into their checkout.
  if (isDevCheckout(root, probe)) {
    return (
      `${head} — but ${root} is a development checkout, so the likely cause is ` +
      `an \`npm install --omit=optional\` (or an interrupted one). Run ` +
      `\`npm install\` in that directory, or set CODEX_PATH to a codex binary ` +
      `you already have.`
    );
  }
  return (
    `${head} — check network/proxy access to registry.npmjs.org and free disk ` +
    `space, then reinstall libi to retry.`
  );
}

/** A tree with a `.git` directory is somebody's working clone, not an install. */
function isDevCheckout(root: string, probe: CodexBinaryProbe = {}): boolean {
  const exists = probe.exists ?? ((p: string) => existsSync(p));
  try {
    return exists(path.join(root, ".git"));
  } catch {
    return false;
  }
}
