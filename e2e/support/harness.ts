import { spawn, spawnSync } from "child_process";
import { randomBytes } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Shared by playwright.config.ts and playwright.electron.config.ts. Plain
 * TypeScript with no Playwright import, so a unit test can load it on its own.
 */

/** The checkout both configs live in. */
export const REPO_ROOT = path.resolve(__dirname, "..", "..");

/**
 * Where the runner keeps the checkout's `next-env.d.ts` as it was before the
 * run. `next dev` rewrites that file to import `<distDir>/dev/types/routes.d.ts`,
 * so an e2e server on its own Next dir (LIBI_NEXT_DIST_DIR, next.config.ts)
 * points it at the e2e dir — and a later `tsc` in the checkout then reads the
 * e2e copy of Next's global route types beside the dev app's, and fails on the
 * duplicates. The file is gitignored; this only keeps the type-check honest.
 *
 * An env var because Playwright re-loads a config in every worker: the value
 * captured by the RUNNER, before its web server started, is the one to keep.
 */
const NEXT_ENV_SNAPSHOT = "LIBI_E2E_NEXT_ENV_DTS";
/** Marks a checkout that had no `next-env.d.ts` before the run. */
const ABSENT = "(libi-e2e: no next-env.d.ts)";

/** Remember `next-env.d.ts` as it is now — once per run. */
export function rememberNextEnvDts(root: string = REPO_ROOT): void {
  if (process.env[NEXT_ENV_SNAPSHOT] !== undefined) return;
  let content = ABSENT;
  try {
    content = fs.readFileSync(path.join(root, "next-env.d.ts"), "utf8");
  } catch {
    /* none yet */
  }
  process.env[NEXT_ENV_SNAPSHOT] = content;
}

/** Put `next-env.d.ts` back the way `rememberNextEnvDts` found it. */
export function restoreNextEnvDts(root: string = REPO_ROOT): void {
  const saved = process.env[NEXT_ENV_SNAPSHOT];
  if (saved === undefined) return;
  const file = path.join(root, "next-env.d.ts");
  try {
    if (saved === ABSENT) {
      fs.rmSync(file, { force: true });
    } else if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== saved) {
      fs.writeFileSync(file, saved);
    }
  } catch {
    /* best effort: the next `next dev` or build rewrites it anyway */
  }
}

/**
 * The ports in `ports` something already accepts connections on, over
 * 127.0.0.1 or ::1. A config module can't await, so the probe is a short
 * synchronous child process; a refused (or unroutable) connect means free.
 */
export function listeningPorts(ports: string[]): string[] {
  const probe = `
    const net = require("net");
    const open = new Set();
    const checks = process.argv.slice(1).flatMap((port) => ["127.0.0.1", "::1"].map((host) => new Promise((resolve) => {
      const socket = net.connect({ host, port: Number(port) });
      const done = (listening) => { socket.destroy(); if (listening) open.add(port); resolve(); };
      socket.setTimeout(1000, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    })));
    Promise.all(checks).then(() => process.stdout.write(JSON.stringify([...open])));
  `;
  const result = spawnSync(process.execPath, ["-e", probe, ...ports], { encoding: "utf8", timeout: 10_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`e2e: could not check whether port ${ports.join(" / ")} is free: ${result.error?.message ?? result.stderr}`);
  }
  return (JSON.parse(result.stdout) as string[]).sort();
}

/**
 * Refuse to start when the studio port or the MCP port beside it is taken.
 * Playwright's own check covers only `webServer.port`/`url`, and nothing
 * checked the MCP port: a libi already holding it would answer the specs'
 * MCP calls instead of the one the run spawned. Checked once, in the runner
 * process: its workers re-load the config while the spawned libi holds both
 * ports, so the checked pair is written back into `process.env[checkedVar]`.
 */
export function assertPortPairFree(opts: { port: string; mcpPort: string; checkedVar: string; portVar: string }): void {
  const { port, mcpPort, checkedVar, portVar } = opts;
  if (process.env[checkedVar] === `${port},${mcpPort}`) return;
  const busy = listeningPorts([port, mcpPort]);
  if (busy.length > 0) {
    throw new Error(
      `e2e: port ${busy.join(" and ")} ${busy.length > 1 ? "are" : "is"} already in use. The libi these tests spawn needs ${port} ` +
        `for the studio and ${mcpPort} for its MCP endpoint, and a libi already listening there would answer the specs instead. ` +
        `Stop whatever holds it, or set ${portVar} to a port whose next port is free too.`,
    );
  }
  process.env[checkedVar] = `${port},${mcpPort}`;
}

/**
 * The Playwright browser cache the SPAWNED libi should use for its own
 * chromium-render / tracking launches.
 *
 * Both configs give that libi a scratch `HOME`, and playwright-core derives its
 * registry directory from the home — so without this it looks for Chromium
 * under a brand-new empty directory and every chromium-render path fails with
 * "Playwright Chromium failed to launch after install" (overlay-sandbox-golden
 * hit exactly that). Pointing it at the RUNNER's cache adds no new requirement:
 * these tests already need a Playwright browser install to drive a page, and it
 * saves a ~173 MB download into a directory each run throws away.
 *
 * Safe against libi's boot housekeeping: `pruneStalePlaywrightRevisions`
 * (lib/server/lifecycle/housekeeping.ts) removes only unpinned revisions
 * carrying libi's own `.libi-installed` marker file, never Playwright's.
 */
export function runnerBrowsersPath(): string {
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (override && override !== "0") return override;
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Caches", "ms-playwright");
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "ms-playwright");
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "ms-playwright");
}

/**
 * Scratch dirs are deleted after a run only when they are this run's BY
 * CONSTRUCTION — never by their name. The owner keeps `/tmp/libi-*` folders of
 * their own, so a name pattern proves nothing. Three checks, all required:
 *  1. the dir was created by this run (`makeOwnedTempDir`, or `createDirIfAbsent`
 *     finding nothing there); a path the caller named through an env var is
 *     never claimed;
 *  2. it is in the claim list (`claimScratch`) stamped with THIS run's id — a
 *     list inherited from some other run's environment is ignored;
 *  3. when the cleanup runs, the dir still holds the marker file this run wrote
 *     into it at creation, with this run's id.
 */

/** This run's id, `<runner pid>:<random>`, shared with its workers through the env. */
const RUN_VAR = "LIBI_E2E_RUN";
const OWNED_SCRATCH = "LIBI_E2E_OWNED_SCRATCH";
/** The marker file an owned scratch dir carries; its content is the run id. */
export const SCRATCH_MARKER = ".libi-e2e-scratch";

/**
 * The current run's id. Playwright workers are forked by the runner, so a value
 * whose pid is this process or its parent is this run's; anything else was
 * inherited from another run's environment (a studio, an agent terminal) and is
 * replaced.
 */
export function e2eRunId(): string {
  const existing = process.env[RUN_VAR];
  const pid = existing ? Number(existing.split(":")[0]) : NaN;
  if (existing && (pid === process.pid || pid === process.ppid)) return existing;
  const id = `${process.pid}:${randomBytes(8).toString("hex")}`;
  process.env[RUN_VAR] = id;
  return id;
}

function writeMarker(dir: string): void {
  fs.writeFileSync(path.join(dir, SCRATCH_MARKER), e2eRunId());
}

/**
 * A new, uniquely named dir `<root>/<prefix>-XXXXXX` (mkdtemp: never an
 * existing or pre-planted name), marked as this run's.
 */
export function makeOwnedTempDir(root: string, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(root, `${prefix}-`));
  writeMarker(dir);
  return dir;
}

/**
 * Create `dir` if nothing is there, and mark it as this run's. `true` only when
 * this call created it: an existing dir is somebody else's, and stays theirs.
 */
export function createDirIfAbsent(dir: string): boolean {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    fs.mkdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  writeMarker(dir);
  return true;
}

/**
 * Record the scratch dirs this run created, with the studio port whose server
 * writes into them — once per run: a worker re-loading the config keeps the
 * runner's list, and a list stamped by another run is replaced.
 */
export function claimScratch(port: string, paths: string[]): void {
  const run = e2eRunId();
  try {
    const existing = JSON.parse(process.env[OWNED_SCRATCH] ?? "null") as { run?: string } | null;
    if (existing?.run === run) return;
  } catch {
    /* unreadable: replace it */
  }
  process.env[OWNED_SCRATCH] = JSON.stringify({ run, port, paths });
}

/**
 * Only a `libi-*` directory directly under `/tmp` or the OS temp dir is ever
 * removed — a last filter on top of the ownership checks above, not a proof.
 *
 * `os.tmpdir()` reads `TMPDIR` (macOS/Linux) / `TEMP`/`TMP` (Windows), which is not
 * trustworthy input: a `TMPDIR` set to (or above) `$HOME` would make `os.tmpdir()`
 * name the home directory itself, so a home-rooted dir like `~/libi-home` would read
 * as "directly under the temp root" and become removable. A root at or above `$HOME`
 * is skipped entirely rather than trusted — the run-id marker check upstream is the
 * real guard, this is only the last filter.
 */
export function isRemovableScratch(p: string): boolean {
  const resolved = path.resolve(p);
  if (!path.basename(resolved).startsWith("libi-")) return false;
  const home = path.resolve(os.homedir());
  const parents = new Set<string>();
  for (const root of ["/tmp", os.tmpdir()]) {
    const resolvedRoot = path.resolve(root);
    const rel = path.relative(resolvedRoot, home);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) continue;
    parents.add(resolvedRoot);
    try {
      parents.add(fs.realpathSync(root));
    } catch {
      /* no such root here */
    }
  }
  return parents.has(path.dirname(resolved));
}

/**
 * Remove the scratch dirs this run claimed, once the studio is gone.
 *
 * Playwright runs the global teardown BEFORE it stops the web server, and a
 * running libi keeps writing its logs into the home. So the removal happens
 * in a small detached process that waits for the studio port to close (up to
 * 3 min; if it never closes, nothing is removed), then deletes each dir whose
 * marker still holds this run's id — and leaves any dir without it.
 */
export function scheduleScratchCleanup(): void {
  const raw = process.env[OWNED_SCRATCH];
  if (!raw) return;
  let owned: { run?: string; port?: string; paths?: string[] };
  try {
    owned = JSON.parse(raw) as { run?: string; port?: string; paths?: string[] };
  } catch {
    return;
  }
  // A list some other run stamped is not ours to act on.
  if (!owned.run || owned.run !== e2eRunId()) return;
  const paths = (owned.paths ?? []).filter(isRemovableScratch);
  if (!owned.port || paths.length === 0) return;
  const script = `
    const net = require("net");
    const fs = require("fs");
    const path = require("path");
    const [port, run, marker, ...paths] = process.argv.slice(1);
    const listening = () => new Promise((resolve) => {
      const s = net.connect({ host: "127.0.0.1", port: Number(port) });
      const done = (v) => { s.destroy(); resolve(v); };
      s.setTimeout(1000, () => done(false));
      s.once("connect", () => done(true));
      s.once("error", () => done(false));
    });
    const ours = (dir) => {
      try {
        const st = fs.lstatSync(dir);
        if (!st.isDirectory()) return false;
        return fs.readFileSync(path.join(dir, marker), "utf8") === run;
      } catch { return false; }
    };
    (async () => {
      const deadline = Date.now() + 180000;
      while (await listening()) {
        if (Date.now() > deadline) return;
        await new Promise((r) => setTimeout(r, 500));
      }
      await new Promise((r) => setTimeout(r, 2000));
      for (const p of paths) {
        if (!ours(p)) continue;
        try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch {}
      }
    })();
  `;
  const child = spawn(process.execPath, ["-e", script, owned.port, owned.run, SCRATCH_MARKER, ...paths], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}
