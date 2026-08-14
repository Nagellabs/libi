// electron/path-bootstrap.ts
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { getLibiBinDir, getLibiHome } from "../lib/libi-home";
import { mainSyncLog } from "./sync-log";

/**
 * When macOS launches an .app via Finder / `open`, the process inherits
 * launchd's environment — which has a minimal PATH like
 * `/usr/bin:/bin:/usr/sbin:/sbin`. Homebrew, proto, nvm etc. are
 * invisible.
 *
 * Libi's own subprocess needs (npm, ffmpeg, yt-dlp, uv) DO NOT depend on
 * this anymore:
 *   - `npm` is vendored — see `lib/mcp/bundled-install.ts`, which spawns
 *     `process.execPath` (the Electron binary running in Node mode) on
 *     `node_modules/npm/bin/npm-cli.js`. No system npm required.
 *   - `ffmpeg`, `ffprobe`, `yt-dlp`, `uv` live under `~/.libi/bin/`, which
 *     `buildSpawnEnv` always prepends.
 *
 * This module remains as a defence-in-depth measure for third-party MCPs
 * we may shell out to (and to keep user-installed `node` etc. visible if
 * the user pokes around). Same trick as sindresorhus/fix-path and
 * VS Code / Cursor.
 *
 * ## Why this is structured the way it is
 *
 * `bootstrapPath()` used to shell out via `execSync(..., { timeout: 2000 })`
 * to ask the user's login shell for its PATH, synchronously, before
 * returning. That is NOT SAFE: a timeout only protects you against a child
 * that is merely slow. It does nothing for a child that is blocked inside
 * the kernel — which is what was actually observed on a packaged boot that
 * hung for 10+ minutes. The spawned `/bin/zsh` sat inside a macOS
 * TCC/sandbox authorization IPC that never got a reply; `execSync`'s
 * `SIGTERM` cannot dequeue a process parked in that wait, so the 2000ms
 * timeout fired against something it couldn't kill and `spawnSync` kept
 * blocking. (Full writeup: `.superpowers/sdd/boot-hang-investigation.md`.
 * This is a DIFFERENT mechanism from — and does not resurrect — the
 * previously-disproven "execSync blocks on a grandchild holding the stdout
 * pipe open" theory; that one really doesn't happen, this one does.)
 *
 * The fix is not a bigger or smarter timeout — no timeout can save you from
 * an OS that never answers. Instead:
 *
 *   1. `bootstrapPath()` applies a known-good PATH (the libi-bin dir, plus
 *      either a cached previously-discovered shell PATH or the hardcoded
 *      fallback locations) SYNCHRONOUSLY before it does anything else, and
 *      returns. Nothing in this step can block, because none of it asks
 *      the OS for anything that might not answer.
 *   2. Only then, if there's no cache yet, does it kick off the login-shell
 *      probe — via `spawn` (async), not `execSync` (sync). `bootstrapPath()`
 *      has already returned by the time this runs, which is what actually
 *      protects BOOT: `spawn` never blocks the caller, full stop. The child,
 *      its stdout pipe, and its guard timer are all `unref()`'d too, as
 *      defense-in-depth against a SEPARATE failure mode — a hung, never-
 *      exiting probe keeping the Node event loop referenced for the rest of
 *      the app's life (see `scheduleShellPathProbe`'s docblock for why the
 *      stdout pipe needs its own explicit `unref()` beyond `child.unref()`).
 *   3. If the probe succeeds, its result is (a) applied to `process.env.PATH`
 *      immediately (refining what's already there — see the ordering note
 *      below) and (b) cached to disk so the NEXT boot skips the probe
 *      entirely: cache hit ⇒ apply the cached PATH synchronously and never
 *      touch the shell. That is what makes a warm boot pay neither the
 *      (usually tiny) cost nor the (rare but real) TCC-hang risk.
 *
 * The cache lives at `<LIBI_HOME>/shell-path-cache.json`, resolved via
 * `getLibiHome()` so it lands in the right place for both the packaged app
 * (`~/Library/Application Support/libi`) and the CLI (`~/.libi`) — never
 * hardcoded. A user's login PATH changes rarely, so the cache is not
 * time-based; delete the file to force a re-probe.
 *
 * ## Late-apply ordering
 *
 * If the probe DOES resolve, it refines `process.env.PATH` after
 * `bootstrapPath()` has already returned — possibly after Category A has
 * already spawned a subprocess or two using the synchronous fallback PATH.
 * This is intentional and safe: `child_process.spawn`/`execFile`/etc. read
 * `process.env` (or an explicit `env` you pass) at the moment THEY are
 * called, not once at process start. A subprocess already spawned before
 * the refinement keeps whatever PATH it was given — it does not retroactively
 * break. Every subprocess spawned AFTER the refinement (which, in practice,
 * is nearly all of them — Category A's install/probe phases spawn many
 * processes over multiple seconds) sees the fuller, shell-discovered PATH.
 * Losing a login-shell-only directory (asdf/nvm/proto shims, say) for the
 * first subprocess or two of a cold boot is an acceptable trade against
 * never being able to hang boot on it.
 *
 * Idempotent: safe to call multiple times.
 */

const SHELL_PROBE_TIMEOUT_MS = 2000;
const PATH_CACHE_FILENAME = "shell-path-cache.json";

interface ShellPathCache {
  shell: string;
  path: string;
}

export function bootstrapPath(): void {
  const pathSep = process.platform === "win32" ? ";" : ":";

  // The libi-bin dir is always prepended first so libi-managed binaries
  // (ffmpeg, ffprobe, yt-dlp, uv, and the node runtime provisioned by
  // `lib/runtime/node-runtime.ts`) shadow any system versions.
  //
  // Resolved via `getLibiBinDir()`, NOT a hardcoded `~/.libi/bin`: the packaged
  // app's home is `~/Library/Application Support/libi`, and `electron/main.ts`
  // sets `LIBI_HOME` before calling this. Hardcoding put the DEVELOPER's bin
  // dir on the packaged app's PATH — so the packaged app would reach for a
  // CLI install's binaries while its own (the ones Category A just installed,
  // including `node`) stayed invisible.
  const libiBin = getLibiBinDir();

  if (process.platform === "darwin" || process.platform === "linux") {
    const cached = readCachedShellPath();
    if (cached) {
      // Warm path: a previous boot already discovered + cached the login
      // shell's PATH. Apply it synchronously and skip the probe entirely —
      // that is the whole point of caching (see docblock above).
      mergePrepend([libiBin, ...splitUnique(cached, pathSep)], pathSep);
      return;
    }
  }

  // Cold path (no cache yet, or a corrupt/absent cache file): apply the
  // libi-bin dir + hardcoded fallback locations SYNCHRONOUSLY, with nothing
  // that depends on the OS answering. This is the PATH boot proceeds with
  // if the probe below never completes.
  const fallback: string[] = [libiBin];
  if (process.platform === "darwin" || process.platform === "linux") {
    fallback.push(
      "/opt/homebrew/bin", // Apple Silicon Homebrew
      "/opt/homebrew/sbin",
      "/usr/local/bin", // Intel Homebrew + linux user-installs
      "/usr/local/sbin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    );
  } else if (process.platform === "win32") {
    const home = process.env.USERPROFILE ?? "";
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    fallback.push(
      path.join(localAppData, "Programs", "nodejs"),
      path.join(home, "AppData", "Roaming", "npm"),
      "C:\\Program Files\\nodejs",
    );
  }
  mergePrepend(fallback, pathSep);

  if (process.platform === "darwin" || process.platform === "linux") {
    scheduleShellPathProbe(libiBin, pathSep);
  }
}

/**
 * Fire-and-forget: ask the user's login shell for its PATH in the
 * background. Must never be awaited or otherwise let boot depend on it —
 * see the module docblock for why a timeout alone cannot bound this.
 *
 * Structural (not timeout-based) guarantee that this cannot wedge BOOT:
 *   - `spawn` (not `execSync`) never blocks the caller; `bootstrapPath()`
 *     has already returned by the time any of this module's callbacks run.
 *     That alone is what protects boot — Electron's main-process lifetime is
 *     driven by `app.quit()`, not by whether the event loop has outstanding
 *     handles, so nothing below needs to keep the loop unref'd for boot to
 *     be safe.
 *
 * We unref the child AND its stdout pipe anyway, as defense-in-depth against
 * this becoming a process-exit hang too (not just a boot hang): `child.unref()`
 * only unrefs the process handle — the stdio pipe is a SEPARATE libuv handle,
 * and attaching a `"data"` listener puts it in flowing mode, which refs the
 * loop on its own. Without also calling `child.stdout.unref()`, a child that
 * never exits and never closes its pipe (the exact TCC-hang scenario this
 * module exists for) would keep a referenced handle open for the app's
 * lifetime — harmless to boot (already returned), but a footgun for anything
 * that waits on the event loop to drain (e.g. a CLI/MCP process exiting
 * naturally). `timer.unref()` covers the guard timer the same way.
 */
function scheduleShellPathProbe(libiBin: string, pathSep: string): void {
  const shell = process.env.SHELL || "/bin/zsh";
  mainSyncLog(`path-bootstrap: shell_path_probe_start shell=${shell}`);
  try {
    const child = spawn(shell, ["-ilc", 'echo -n "$PATH"'], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.unref();

    let stdout = "";
    let settled = false;

    // Bounds how long we keep LISTENING, not how long the child lives —
    // we cannot force a TCC-blocked process to die (see docblock). Once
    // this fires we simply stop caring about the result; boot is long
    // since unaffected either way.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      mainSyncLog(
        `path-bootstrap: shell_path_probe_timeout shell=${shell} bufferedBytes=${stdout.length}`,
      );
      // The shell may have already printed a usable PATH before whatever is
      // holding the pipe open (a backgrounded job from an rc file, or the
      // TCC-blocked shell itself) prevented "close" from firing. Apply +
      // cache what we have rather than discarding it — see finding 4.
      applyProbeResult(stdout, shell, libiBin, pathSep);
      try {
        child.kill();
      } catch {
        /* best-effort; may legitimately be unkillable — ignore */
      }
      unrefStdout(child);
    }, SHELL_PROBE_TIMEOUT_MS);
    timer.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    unrefStdout(child);

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      mainSyncLog(`path-bootstrap: shell_path_probe_done shell=${shell} bytes=${stdout.length}`);
      applyProbeResult(stdout, shell, libiBin, pathSep);
    };

    child.on("close", finish);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      mainSyncLog(
        `path-bootstrap: shell_path_probe_done shell=${shell} error=${(err as Error).message}`,
      );
      // Spawn/runtime error — leave the fallback PATH in place, no cache write.
    });
  } catch (err) {
    // Never throw — a failed probe just means we keep the fallback PATH.
    mainSyncLog(
      `path-bootstrap: shell_path_probe_done shell=${shell} error=${(err as Error).message}`,
    );
  }
}

/**
 * Node types `ChildProcess.stdout` as a generic `Readable`, which has no
 * `unref()` — but with `stdio: ["ignore", "pipe", "ignore"]` the object at
 * runtime is always a pipe handle (a `net.Socket`-like stream) that DOES
 * have one. Narrow locally instead of reaching for `any`.
 */
interface UnrefableStream {
  unref?: () => void;
}

function unrefStdout(child: ChildProcess): void {
  (child.stdout as UnrefableStream | null)?.unref?.();
}

/**
 * Apply + cache a probe's stdout, if it looks like a sane PATH value.
 *
 * `-ilc` runs the shell interactively, so rc files that print banners
 * (oh-my-zsh update prompts, `fortune`, `neofetch`, etc.) can mix into
 * stdout ahead of/around the `echo -n "$PATH"` output. A cache hit skips
 * BOTH the probe and the hardcoded fallback on every future boot, so a
 * one-time bad capture would otherwise persist indefinitely. A real PATH
 * value is a single line with no embedded newline — reject anything else
 * as a cheap sanity bound rather than trying to parse banner noise out.
 */
function applyProbeResult(stdout: string, shell: string, libiBin: string, pathSep: string): void {
  const trimmed = stdout.trim();
  if (trimmed.length === 0 || trimmed.includes("\n")) return;
  mergePrepend([libiBin, ...splitUnique(trimmed, pathSep)], pathSep);
  writeCachedShellPath(shell, trimmed);
}

/** Merge `prepend` (in order) ahead of the current `process.env.PATH`, de-duped. */
function mergePrepend(prepend: string[], pathSep: string): void {
  const original = process.env.PATH ?? "";
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const dir of [...prepend, ...splitUnique(original, pathSep)]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    merged.push(dir);
  }
  process.env.PATH = merged.join(pathSep);
}

function splitUnique(p: string, sep: string): string[] {
  return p.split(sep).filter((s) => s.length > 0);
}

function pathCacheFile(): string {
  return path.join(getLibiHome(), PATH_CACHE_FILENAME);
}

/**
 * Read the cached shell PATH, if any. Returns null (never throws) on a
 * missing file, unparseable JSON, a shape mismatch, or a cache written for
 * a different `$SHELL` than the current one — all of which degrade cleanly
 * to the cold path (hardcoded fallback + a fresh probe).
 */
function readCachedShellPath(): string | null {
  try {
    const raw = fs.readFileSync(pathCacheFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<ShellPathCache>;
    const shell = process.env.SHELL || "/bin/zsh";
    if (typeof parsed.path === "string" && parsed.path.length > 0 && parsed.shell === shell) {
      return parsed.path;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Best-effort cache write. Never throws — a failed write only costs the
 * next boot a re-probe, it must never affect the CURRENT boot.
 */
function writeCachedShellPath(shell: string, shellPath: string): void {
  try {
    const home = getLibiHome();
    fs.mkdirSync(home, { recursive: true });
    const cache: ShellPathCache = { shell, path: shellPath };
    fs.writeFileSync(pathCacheFile(), JSON.stringify(cache), "utf8");
  } catch {
    /* best-effort — ignore */
  }
}
