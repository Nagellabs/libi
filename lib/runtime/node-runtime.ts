/**
 * A Node.js runtime libi can always reach.
 *
 * ## The problem
 *
 * libi spawns two kinds of child that need a real `node` executable:
 *
 *   1. The libi MCP server — `buildLibiEntry()` (lib/mcp-config.ts) hands the
 *      ACP adapter a `{ command, args }` pair; the adapter's own `spawn()`
 *      launches it. libi is not the parent, so it cannot substitute its own
 *      process model here.
 *   2. The Claude ACP adapter — `~/.libi/agents/node_modules/.bin/claude-agent-acp`
 *      is a `#!/usr/bin/env node` script.
 *
 * Both used to resolve `node` off `PATH`. In a packaged Electron app launched
 * from Finder/launchd, PATH is `/usr/bin:/bin:/usr/sbin:/sbin` — and the
 * hardcoded fallback list in `electron/path-bootstrap.ts` adds only Homebrew
 * and `/usr/local`. A user whose node lives in a version manager (fnm, nvm,
 * asdf, volta, proto — the common case on macOS) has NO node in any of those
 * directories, so the spawn dies with `node: command not found` and the agent
 * simply never starts. The login-shell PATH probe usually rescues this, but it
 * is deliberately non-blocking and best-effort: it timed out on 2 of 3 packaged
 * boots during the acceptance gate, which is precisely when the fallback PATH
 * — the one with no node — is what the spawn sees.
 *
 * ## Why not `process.execPath`
 *
 * Under Electron that is the app binary, and `electronFuses.runAsNode: false`
 * makes it IGNORE `ELECTRON_RUN_AS_NODE`: spawning it launches a second full
 * Libi GUI (a 7-minute recursive boot, previously investigated). And
 * `utilityProcess.fork()` — the sanctioned in-process Node child, see
 * `lib/install/npm-root.ts` — cannot be used either, because these children are
 * stdio peers of a THIRD-PARTY process (the ACP adapter / Claude CLI), not of
 * libi's main process. Nothing node-executable is guaranteed to exist inside a
 * packaged Electron app, so libi has to guarantee one itself.
 *
 * ## What this module does
 *
 * `ensureNodeRuntime()` (run once per boot, non-fatally, from Category A)
 * guarantees `<LIBI_HOME>/bin/node` exists:
 *
 *   - already there and runnable  → nothing to do (the warm path);
 *   - a usable system node found  → symlink to its REALPATH (so a version
 *     manager's per-shell-invocation shim directory is never pinned);
 *   - nothing found anywhere      → download the pinned official Node build
 *     from nodejs.org, sha256-verify it, and extract just the binary.
 *
 * `resolveNodeCommand()` is the read side, called on every spawn path. It is
 * cheap by construction — one `fs.existsSync` (which follows symlinks, so a
 * dangling link self-heals to the fallback) and no subprocesses.
 *
 * `<LIBI_HOME>/bin` is already prepended to the PATH of every MCP child by
 * `buildSpawnEnv()` and to the main process by `bootstrapPath()`, so this also
 * makes plain `#!/usr/bin/env node` shebangs resolve for grandchildren libi
 * never sees.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { getLibiBinDir, getLibiHome } from "@/lib/libi-home";
import { sidecarMajorsIn } from "@/lib/runtime/node-abi-sidecars";
// `native-binding.ts` imports nothing but `node:fs`/`node:path`, so this is a
// leaf dependency, not a layering inversion — and it is the ONE module that
// knows where a runtime's better-sqlite3 build dir lives. Re-deriving that
// here would be the drift risk the shared sidecar module exists to remove.
import { sqliteBuildDirForChildren } from "@/lib/db/native-binding";
import {
  downloadToFileWithStallGuard,
  fetchWithHttpsOnlyRedirects,
} from "@/lib/security/download-verify";

/**
 * Run a command, resolving on exit 0. Hand-rolled rather than
 * `promisify(execFile)` at module scope: touching a `child_process` export
 * during module evaluation makes this module un-importable from any suite that
 * partially mocks `child_process` (several do), and this module is now on the
 * import path of the MCP-config and agent-registry code those suites cover.
 */
function runCommand(cmd: string, args: string[], opts: { timeout?: number } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Pinned Node.js release used when the machine has none of its own.
 *
 * Bump deliberately: the sha256 table below must be regenerated from
 * `https://nodejs.org/dist/<version>/SHASUMS256.txt` in the same commit.
 * An existing `<LIBI_HOME>/bin/node` is NOT re-downloaded on a bump — any
 * runnable node of a sufficient major version is fine for our purposes, and
 * silently re-fetching 50 MB on every boot after a version bump would be a
 * far worse trade than staying one release behind.
 */
export const PINNED_NODE_VERSION = "v24.18.0";

/**
 * Minimum acceptable major version for a SYSTEM node. tsx (which runs the libi
 * MCP) and the ACP adapters both target modern Node; an ancient system node
 * would fail in ways far harder to diagnose than "we ignored it".
 */
export const MIN_NODE_MAJOR = 20;

/** sha256 of the official archive, keyed `<platform>-<arch>`. */
const NODE_ARCHIVE_SHA256: Record<string, string> = {
  "darwin-arm64": "e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1",
  "darwin-x64": "dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080",
  "linux-arm64": "6b4484c2190274175df9aa8f28e2d758a819cb1c1fe6ab481e2f95b463ab8508",
  "linux-x64": "783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8",
  "win32-arm64": "f274669adb93b1fd0fbf8f21fd078609e9dcc84333d4f2718d2dde3f9a161a01",
  "win32-x64": "0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821",
};

export interface NodeArchiveTarget {
  url: string;
  sha256: string;
  /** Path of the node binary INSIDE the extracted archive. */
  innerPath: string;
}

/** Resolve the official download for a platform/arch, or null when unsupported. */
export function nodeArchiveTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  version: string = PINNED_NODE_VERSION,
): NodeArchiveTarget | null {
  const sha256 = NODE_ARCHIVE_SHA256[`${platform}-${arch}`];
  if (!sha256) return null;
  const osKey = platform === "win32" ? "win" : platform === "darwin" ? "darwin" : "linux";
  const stem = `node-${version}-${osKey}-${arch}`;
  const ext = platform === "win32" ? "zip" : "tar.gz";
  return {
    url: `https://nodejs.org/dist/${version}/${stem}.${ext}`,
    sha256,
    innerPath:
      platform === "win32"
        ? path.join(stem, "node.exe")
        : path.join(stem, "bin", "node"),
  };
}

/** File name of the node executable on this platform. */
export function nodeBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "node.exe" : "node";
}

/** Absolute path of the libi-managed node, whether or not it exists yet. */
export function managedNodePath(): string {
  return path.join(getLibiBinDir(), nodeBinaryName());
}

/**
 * The command to spawn for "run this JS file with Node".
 *
 * Returns the libi-managed absolute path when it is present (the only answer
 * that is independent of PATH), otherwise the bare name so a normally-
 * configured dev machine — and any boot before `ensureNodeRuntime()` has had a
 * chance to run — behaves exactly as it did before.
 */
export function resolveNodeCommand(): string {
  const managed = managedNodePath();
  // existsSync follows symlinks: a link whose target was uninstalled reports
  // false here and `ensureNodeRuntime()` repairs it on the next boot.
  if (fs.existsSync(managed)) return managed;
  return nodeBinaryName();
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform === "win32") return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Directories a version manager keeps its real node installs in.
 *
 * Each manager's own relocation env var is honored FIRST, falling back to its
 * documented default when unset — a user with `NVM_DIR`/`FNM_DIR`/
 * `ASDF_DATA_DIR`/`MISE_DATA_DIR`/`VOLTA_HOME` pointed somewhere non-default
 * (an external drive, a dotfiles-managed XDG layout) would otherwise never be
 * found here, and `ensureNodeRuntime()` would download its own 50 MB copy
 * despite a perfectly usable node already on disk.
 */
export function versionManagerDirs(): string[] {
  const home = os.homedir();
  const dirs: string[] = [];
  const nvmRoot = process.env.NVM_DIR || path.join(home, ".nvm");
  const asdfRoot = process.env.ASDF_DATA_DIR || path.join(home, ".asdf");
  const miseRoot = process.env.MISE_DATA_DIR || path.join(home, ".local", "share", "mise");
  const voltaRoot = process.env.VOLTA_HOME || path.join(home, ".volta");
  // fnm has no single documented default across platforms (see the three
  // hardcoded layouts below), so FNM_DIR — when set — is searched IN ADDITION
  // to them rather than replacing any one of them.
  const fnmRoot = process.env.FNM_DIR;

  const globParents: Array<{ root: string; suffix: string[] }> = [
    // nvm
    { root: path.join(nvmRoot, "versions", "node"), suffix: ["bin"] },
    // fnm (explicit FNM_DIR first, then both XDG layouts it has shipped)
    ...(fnmRoot
      ? [{ root: path.join(fnmRoot, "node-versions"), suffix: ["installation", "bin"] }]
      : []),
    { root: path.join(home, ".local", "share", "fnm", "node-versions"), suffix: ["installation", "bin"] },
    { root: path.join(home, ".fnm", "node-versions"), suffix: ["installation", "bin"] },
    { root: path.join(home, "Library", "Application Support", "fnm", "node-versions"), suffix: ["installation", "bin"] },
    // asdf / mise
    { root: path.join(asdfRoot, "installs", "nodejs"), suffix: ["bin"] },
    { root: path.join(miseRoot, "installs", "node"), suffix: ["bin"] },
    // proto
    { root: path.join(home, ".proto", "tools", "node"), suffix: ["bin"] },
    // n
    { root: path.join(home, "n", "n", "versions", "node"), suffix: ["bin"] },
  ];
  for (const { root, suffix } of globParents) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    // Newest-looking first so we don't pin an ancient install when several
    // are present. Lexicographic on the version dir is good enough here.
    for (const entry of entries.sort().reverse()) {
      dirs.push(path.join(root, entry, ...suffix));
    }
  }
  // Flat installs
  dirs.push(
    path.join(voltaRoot, "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, "n", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  );
  return dirs;
}

/** PATH entries from the login-shell PATH cache written by `electron/path-bootstrap.ts`. */
function cachedShellPathDirs(): string[] {
  try {
    const raw = fs.readFileSync(path.join(getLibiHome(), "shell-path-cache.json"), "utf8");
    const parsed = JSON.parse(raw) as { path?: unknown };
    if (typeof parsed.path !== "string") return [];
    return parsed.path.split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  } catch {
    return [];
  }
}

/** Major version of a node binary, or null when it can't be run. */
export function nodeMajorVersion(binary: string): number | null {
  try {
    const out = execFileSync(binary, ["-v"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = /^v(\d+)\./.exec(out.trim());
    return m ? Number.parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

/**
 * Every directory searched for an existing node, in priority order: the
 * current PATH, the login-shell PATH cache, then known version-manager
 * install roots.
 */
export function defaultNodeSearchDirs(): string[] {
  const pathDirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  return [...pathDirs, ...cachedShellPathDirs(), ...versionManagerDirs()];
}

/**
 * Find a usable node already on this machine. Returns the REALPATH so callers
 * never pin an ephemeral shim directory (a version manager's per-shell
 * `fnm_multishells/<pid>_<ts>/bin` is not a durable location).
 *
 * `searchDirs` is a parameter so tests can bound the search to a fixture tree
 * instead of whatever the host machine happens to have installed.
 */
export function findSystemNode(
  searchDirs: string[] = defaultNodeSearchDirs(),
  acceptMajor: (major: number) => boolean = () => true,
): string | null {
  const binName = nodeBinaryName();
  const managed = managedNodePath();
  const seen = new Set<string>();

  for (const dir of searchDirs) {
    if (!dir) continue;
    const candidate = path.join(dir, binName);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    // Skip our own managed copy — callers use it directly; treating it as a
    // "system" find would make ensureNodeRuntime() symlink it to itself.
    if (candidate === managed) continue;
    if (!isExecutableFile(candidate)) continue;
    const major = nodeMajorVersion(candidate);
    if (major === null || major < MIN_NODE_MAJOR) continue;
    if (!acceptMajor(major)) continue;
    try {
      return fs.realpathSync(candidate);
    } catch {
      return candidate;
    }
  }
  return null;
}

/**
 * Node majors THIS runtime carries a better-sqlite3 binding for, or `null` when
 * the question does not apply.
 *
 * `null` means "no sidecars anywhere" — the plain-`npx` layout, where npm
 * compiled `build/Release` for whatever node ran the install. Constraining the
 * interpreter there would create the very mismatch this exists to prevent, in
 * reverse: a pinned-24 download against a binding built for the host's node.
 *
 * A non-null set means the packaged layout, where `build/Release` is
 * deliberately ELECTRON's and the plain-node child can only use a sidecar.
 * `findSystemNode` had no upper bound at all, so a mainstream macOS machine
 * (Homebrew's current `node` is 25.x) got a linked Node 25 with no sidecar to
 * match — and every DB-backed `libi.*` tool died while the UI stayed green.
 */
export function sidecarCoveredMajors(): Set<number> | null {
  try {
    const buildDir = sqliteBuildDirForChildren();
    if (!buildDir) return null;
    const majors = sidecarMajorsIn(buildDir);
    return majors.length > 0 ? new Set(majors) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

export type NodeRuntimeOutcome =
  | { ok: true; path: string; source: "already-managed" | "linked-system" | "downloaded" }
  | { ok: false; error: string };

/**
 * Progress ticks for `ensureNodeRuntime()`. Consumed by Category A
 * (`lib/server/lifecycle/category-a.ts`) to drive the same `lifecycleEvents`
 * install-start/-progress/-done sequence every other phase emits — see the
 * module doc for why a silent boot-blocking download is the failure shape
 * CLAUDE.md calls out ("thinking forever").
 */
export interface NodeRuntimeProgress {
  phase: "linking" | "downloading" | "extracting" | "installing";
  bytesDownloaded?: number;
  bytesTotal?: number | null;
}

/**
 * Retained for callers that reference it (and for the Category A comment that
 * names it), but the download itself no longer uses a TOTAL timeout.
 *
 * It used to be `AbortSignal.timeout(60_000)` around the whole transfer. The
 * pinned archives are 37-57 MB, so that made ~5-7.6 Mbit/s a hard floor on
 * who could provision a node at all: below it, the fetch aborted every time on
 * a link that was working perfectly. `downloadPinnedNode` now uses
 * `downloadToFileWithStallGuard`, whose deadline is IDLE time — a slow-but-
 * alive connection finishes, a dead one still fails fast — which is the same
 * mechanism this branch introduced for the packaged first-boot hang.
 */
export const NODE_DOWNLOAD_FETCH_TIMEOUT_MS = 60_000;

/**
 * Safety cap on the downloaded archive size. The real official archives are
 * ~30-50 MB; this is a generous multiple, not a tuned estimate — sha256
 * verification only happens AFTER the whole body is buffered, so an
 * unbounded response (misbehaving mirror, MITM) would otherwise be free to
 * exhaust memory/disk before that check ever runs.
 */
export const NODE_DOWNLOAD_MAX_BYTES = 300 * 1024 * 1024; // 300 MB

/**
 * Install `dest` atomically: write into a sibling temp file, chmod it
 * executable, then `rename()` into place (M2). `rename()` on the same
 * filesystem is atomic on both POSIX and Windows, so a crash mid-write (or
 * mid-copy) can only ever leave the ABANDONED temp file behind — every
 * reader of `dest` (`resolveNodeCommand()`'s `existsSync`, any spawn) either
 * sees the fully-old file or the fully-new one, never a truncated/partial
 * one. `write` receives the temp path and is responsible for populating it.
 */
function atomicInstallExecutable(dest: string, write: (tmpPath: string) => void): void {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(dest)}.tmp-${process.pid}-${Date.now()}`);
  try {
    write(tmpPath);
    fs.chmodSync(tmpPath, 0o755);
    fs.renameSync(tmpPath, dest);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}

async function downloadPinnedNode(onProgress?: (p: NodeRuntimeProgress) => void): Promise<string> {
  const target = nodeArchiveTarget();
  if (!target) {
    throw new Error(
      `no pinned Node.js build for ${process.platform}-${process.arch}; install Node.js ${MIN_NODE_MAJOR}+ manually`,
    );
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-node-"));
  try {
    const archivePath = path.join(
      tmpDir,
      process.platform === "win32" ? "node.zip" : "node.tar.gz",
    );
    onProgress?.({ phase: "downloading", bytesDownloaded: 0, bytesTotal: null });
    // ── Why the stall guard, and not the 60s total timeout this used ───────
    //
    // `AbortSignal.timeout(60_000)` bounds the WHOLE transfer, not idle time,
    // and there is no retry. The pinned archives measure 37–57 MB, so any
    // connection under roughly 5–7.6 Mbit/s could NEVER provision a node — it
    // would abort mid-download every single time, on a link that works fine.
    // That is a hard floor on who can run libi, expressed as a timeout.
    //
    // `downloadToFileWithStallGuard` is this branch's own answer to exactly
    // that shape of bug (it is what fixed the packaged first-boot hang): an
    // IDLE deadline plus bounded retries, so a slow-but-alive link finishes
    // and a genuinely dead one still fails fast. It also streams to disk
    // rather than holding 52 MB in memory, and it goes through
    // `fetchWithHttpsOnlyRedirects`, closing a redirect-downgrade gap the
    // bare `fetch` here left open.
    //
    // The sha256 is verified from the value it returns, BEFORE the bytes are
    // used — same pin, same guarantee, one less hashing pass.
    const dl = await downloadToFileWithStallGuard(target.url, archivePath, {
      label: `Node.js ${PINNED_NODE_VERSION}`,
      onProgress: ({ bytesDownloaded, bytesTotal }) =>
        onProgress?.({ phase: "downloading", bytesDownloaded, bytesTotal }),
      // Keep the declared-size pre-filter: refuse an absurd `content-length`
      // before a single body byte is read. It wraps rather than replaces the
      // default transport, so HTTPS-only redirect enforcement is retained.
      doFetch: async (url, init) => {
        const res = await fetchWithHttpsOnlyRedirects(url, init);
        const declared = Number(res.headers.get("content-length") ?? NaN);
        if (Number.isFinite(declared) && declared > NODE_DOWNLOAD_MAX_BYTES) {
          throw new Error(
            `GET ${url} → declared content-length ${declared} exceeds ${NODE_DOWNLOAD_MAX_BYTES}-byte cap`,
          );
        }
        return res;
      },
    });
    // …and enforce it again on the bytes that actually arrived, because a
    // missing or lying `content-length` is the case the pre-filter cannot see.
    if (dl.bytesDownloaded > NODE_DOWNLOAD_MAX_BYTES) {
      throw new Error(
        `GET ${target.url} → response ${dl.bytesDownloaded} bytes exceeds ${NODE_DOWNLOAD_MAX_BYTES}-byte cap`,
      );
    }
    if (dl.sha256 !== target.sha256) {
      throw new Error(
        `sha256 mismatch for ${target.url} (expected ${target.sha256}, got ${dl.sha256})`,
      );
    }
    fs.renameSync(dl.tmpPath, archivePath);

    onProgress?.({ phase: "extracting" });
    // Modern macOS / Linux / Win10+ all ship a `tar` that reads zip and gzip —
    // the same assumption `DependencyManager.extractArchive` already makes.
    await runCommand("tar", ["-xf", archivePath, "-C", tmpDir], { timeout: 120_000 });

    const extracted = path.join(tmpDir, target.innerPath);
    if (!fs.existsSync(extracted)) {
      throw new Error(`extracted archive has no ${target.innerPath}`);
    }
    onProgress?.({ phase: "installing" });
    const dest = managedNodePath();
    // Copy (not rename) from tmpDir: it is frequently a different filesystem,
    // so a direct rename would fail with EXDEV. atomicInstallExecutable's
    // OWN internal rename (same dir as `dest`) is what makes the final
    // install step atomic.
    atomicInstallExecutable(dest, (tmpPath) => fs.copyFileSync(extracted, tmpPath));
    return dest;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Guarantee `<LIBI_HOME>/bin/node` exists and runs. Never throws — the caller
 * (Category A) treats failure as non-fatal: libi still boots, the Terminal
 * surface still works, and `resolveNodeCommand()` degrades to bare `"node"`,
 * i.e. exactly the pre-existing behaviour.
 */
export async function ensureNodeRuntime(
  searchDirs: string[] = defaultNodeSearchDirs(),
  onProgress?: (p: NodeRuntimeProgress) => void,
): Promise<NodeRuntimeOutcome> {
  const managed = managedNodePath();
  // In a packaged runtime, only a major we ship a better-sqlite3 sidecar for
  // can actually open the database from the MCP child. Outside that layout
  // (`null`) the constraint does not apply and behaviour is unchanged.
  const covered = sidecarCoveredMajors();
  const acceptable = (major: number | null): boolean =>
    major != null && major >= MIN_NODE_MAJOR && (covered == null || covered.has(major));

  try {
    // Re-resolve an already-managed node whose major we cannot serve — this is
    // what heals a machine that linked an uncovered system node before this
    // check existed, rather than leaving it broken until someone deletes
    // `<LIBI_HOME>/bin/node` by hand.
    if (fs.existsSync(managed) && acceptable(nodeMajorVersion(managed))) {
      return { ok: true, path: managed, source: "already-managed" };
    }
    // Dangling symlink or an unrunnable leftover — clear it so the repair
    // paths below have a clean slot.
    try {
      fs.lstatSync(managed);
      fs.rmSync(managed, { force: true });
    } catch {
      /* nothing there */
    }

    // When nothing on this machine matches a shipped binding, downloading the
    // pinned build is strictly better than linking a node whose every database
    // call will fail. `PINNED_NODE_VERSION`'s major is in the shipped set by
    // construction (see NODE_ABI_SIDECAR_MAJORS).
    const system = findSystemNode(searchDirs, (m) => covered == null || covered.has(m));
    if (system) {
      onProgress?.({ phase: "linking" });
      fs.mkdirSync(path.dirname(managed), { recursive: true });
      try {
        fs.symlinkSync(system, managed);
      } catch {
        // Windows without developer mode (and some network filesystems) refuse
        // symlinks — copying the binary is a fine substitute. Atomic for the
        // same reason the download path is (M2).
        atomicInstallExecutable(managed, (tmpPath) => fs.copyFileSync(system, tmpPath));
      }
      return { ok: true, path: managed, source: "linked-system" };
    }

    const downloaded = await downloadPinnedNode(onProgress);
    return { ok: true, path: downloaded, source: "downloaded" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
