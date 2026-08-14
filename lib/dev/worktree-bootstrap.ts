import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import net from "net";
import { migrateDatabase } from "../db/client";
import { serverLogger as logger } from "../logger";

export const WORKTREE_HOMES_ROOT = path.join(
  os.homedir(),
  ".libi",
  "worktrees",
);
/**
 * Subdirectories of a worktree's LIBI_HOME that are symlinked to the canonical
 * `~/.libi` rather than populated per-worktree, because re-provisioning them
 * is slow and their contents are not worktree-specific.
 *
 * `uv` holds every uv-managed artifact (`lib/uv-env/spawn-env.ts`): the wheel /
 * sdist cache, `uv run --with` ephemeral environments, managed CPython
 * interpreters, `uv tool` installs, and the tracking sidecar's project venv.
 * That is multi-gigabyte — 2.6 GB of it torch — so scoping it per worktree
 * would make every worktree re-download the whole Python stack. Sharing it
 * matches why `bin`/`models`/`node_modules` are already shared.
 *
 * Sharing the project venv is also required for correctness, not just speed:
 * the tracking install token lives in the shared `models/tracking/` tree, so a
 * per-worktree venv would let `verify()` report "installed" while the venv it
 * attests to did not exist for that worktree.
 *
 * Caveat (dev-only): a worktree that edits `mcp/tracking/py/{pyproject.toml,
 * uv.lock}` shares one venv with the canonical checkout, so `uv sync` will
 * re-resolve when switching between them.
 */
export const SHARED_LINKS = ["bin", "models", "node_modules", "uv"] as const;
export const PORT_RANGE_START = 3456;
export const PORT_RANGE_SIZE = 20;
/** Base for the per-worktree Electron CDP (remote-debugging) port. The CDP
 *  port is derived 1:1 from the Next port so every worktree gets a distinct
 *  remote-debugging endpoint (and a distinct .mcp.json playwright endpoint),
 *  letting worktrees + the canonical checkout run Electron side-by-side
 *  instead of all fighting over the hardcoded 9222. */
export const CDP_PORT_BASE = 9222;
export const LAUNCH_JSON_REL = path.join(".claude", "launch.json");
export const MCP_JSON_REL = ".mcp.json";
export const META_FILENAME = "worktree-meta.json";

/** Map a resolved Next port to its companion CDP port (1:1, same offset). */
export function cdpPortForNextPort(nextPort: number): number {
  return CDP_PORT_BASE + (nextPort - PORT_RANGE_START);
}

/** Base for the per-worktree terminal WebSocket port (lib/terminal/ws-server).
 *  Derived 1:1 from the Next port like the CDP port, so every worktree's
 *  terminal ws server gets a stable, distinct loopback port and worktrees
 *  can run terminals side-by-side. 9322 keeps a full PORT_RANGE_SIZE of
 *  clearance above the CDP block (9222..9241). */
export const TERMINAL_WS_PORT_BASE = 9322;

/** Map a resolved Next port to its companion terminal ws port (1:1). */
export function terminalWsPortForNextPort(nextPort: number): number {
  return TERMINAL_WS_PORT_BASE + (nextPort - PORT_RANGE_START);
}

/**
 * Walk up from `start` looking for a `.git` dir OR `.git` file (worktree
 * links use a file). Returns true the moment one is found.
 *
 * The walk STOPS AT THE PACKAGE ROOT — the first ancestor holding a
 * `package.json` — and never inspects anything above it. Without that stop
 * the answer is about the *consumer's* tree, not this package: `libi`
 * installed at `<userproject>/node_modules/libi` next to a `<userproject>/.git`
 * reported `true`, and the caller (`lib/cli/studio.ts`) then spawned
 * `npx next dev` INSIDE THE USER'S PROJECT. The same is true one level out:
 * an extracted runtime under `~/.libi/runtime/<version>/` inherits a `true`
 * from a `~/.git` dotfiles repo. "`.git` is never present in a published
 * npm tarball" is true of the package's OWN `.git` and says nothing about an
 * ancestor's, which is exactly the hole this closes.
 *
 * A dev checkout's root has BOTH `package.json` and `.git`, so `.git` is
 * checked first at each level and the dev answer is unchanged. The explicit
 * `node_modules` short-circuit is belt-and-braces for layouts where a
 * dependency somehow lacks a `package.json` above the start path.
 */
export function inDevCheckout(start: string): boolean {
  let dir = path.resolve(start);
  // An installed dependency always sits under a `node_modules` path segment.
  if (dir.split(path.sep).includes("node_modules")) return false;
  for (let i = 0; i < 32; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return true;
    // Package root reached without a `.git` → an installed/extracted copy.
    if (fs.existsSync(path.join(dir, "package.json"))) return false;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

/** Linked worktree iff `git --git-dir != --git-common-dir` for `cwd`. */
export function isLinkedWorktree(cwd: string): boolean {
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd,
      encoding: "utf-8",
    }).trim();
    const gitCommon = execFileSync(
      "git",
      ["rev-parse", "--git-common-dir"],
      { cwd, encoding: "utf-8" },
    ).trim();
    return path.resolve(cwd, gitDir) !== path.resolve(cwd, gitCommon);
  } catch {
    return false;
  }
}

export interface ExistingHome {
  key: string;
  worktreePath: string;
}

/** Stable key for a worktree home dir. basename(worktreePath) — appended
 *  with a 6-char sha256 prefix only if a DIFFERENT worktree already claims
 *  that basename. Idempotent for the same worktreePath. */
export function resolveKey(
  worktreePath: string,
  existing: ExistingHome[],
): string {
  const base = path.basename(worktreePath);
  const claim = existing.find((e) => e.key === base);
  if (!claim) return base;
  if (claim.worktreePath === worktreePath) return base; // idempotent
  const hash = crypto
    .createHash("sha256")
    .update(worktreePath)
    .digest("hex")
    .slice(0, 6);
  return `${base}-${hash}`;
}

export interface SetupHomeOpts {
  home: string;
  worktreePath: string;
  /** Canonical libi root (the parent of `bin`/`models`/`node_modules`).
   *  Default `~/.libi`. Overridable for tests. */
  libiRoot?: string;
  /** Creates the worktree's fresh DB (migrate + seed). Injectable for tests;
   *  defaults to the real `migrateDatabase`. */
  migrate?: (dbPath: string, migrationsFolder: string) => void;
}

/** Idempotent: creates the home dir, writes worktree-meta.json, and
 *  ensures `bin`/`models`/`node_modules` are symlinks to <libiRoot>/<sub>.
 *  Throws if a non-symlink real file/dir is already in the way. */
export function setupWorktreeHome(opts: SetupHomeOpts): void {
  const libiRoot = opts.libiRoot ?? path.join(os.homedir(), ".libi");
  fs.mkdirSync(opts.home, { recursive: true });

  for (const sub of SHARED_LINKS) {
    const target = path.join(libiRoot, sub);
    fs.mkdirSync(target, { recursive: true }); // ensure target exists
    const link = path.join(opts.home, sub);
    let lst: fs.Stats | null = null;
    try {
      lst = fs.lstatSync(link);
    } catch {
      lst = null;
    }
    if (lst?.isSymbolicLink()) {
      const current = fs.readlinkSync(link);
      if (current === target) continue; // already correct
      fs.unlinkSync(link);
      fs.symlinkSync(target, link);
      continue;
    }
    if (lst) {
      throw new Error(
        `worktree-bootstrap: refusing to replace non-symlink at ${link}`,
      );
    }
    fs.symlinkSync(target, link);
  }

  const metaPath = path.join(opts.home, META_FILENAME);
  let prev: { worktreePath?: string; createdAt?: string } = {};
  try {
    prev = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {
    /* missing or malformed — overwrite */
  }
  const firstRun = !prev.createdAt;
  const meta = {
    worktreePath: opts.worktreePath,
    createdAt: prev.createdAt ?? new Date().toISOString(),
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");

  // First-run only: create a FRESH, fully-migrated + seeded DB for this
  // worktree — do NOT copy the canonical ~/.libi/libi.sqlite.
  //
  // We used to copy the main DB to preserve the user's MCP configs + pieces,
  // but that also inherited the canonical DB's migration journal. drizzle's
  // better-sqlite3 migrator decides what to apply by comparing each migration's
  // authoring timestamp to the max recorded apply-time, so a canonical DB whose
  // journal was rebased (apply-time later than a newer migration's authoring
  // time) gets stuck: drizzle silently skips those migrations and can never
  // advance. Every worktree copied off it then inherited the broken, half-
  // migrated schema (missing tables/columns → upload failures, hung queries).
  //
  // A fresh DB replays 0000..N cleanly. Category A's binary-install reads the
  // `mcp_servers` table BEFORE Category B's db-migrate runs, so we migrate +
  // seed here (synchronously, before the bootstrap returns) — a brand-new empty
  // file would make the install loop throw "no such table: mcp_servers".
  // Bundled MCPs re-seed and API keys come from the canonical .env.local
  // (loaded separately), so nothing essential is lost; worktrees intentionally
  // start from an empty-but-current schema.
  if (firstRun) {
    const destDb = path.join(opts.home, "libi.sqlite");
    if (!fs.existsSync(destDb)) {
      try {
        const runMigrate = opts.migrate ?? migrateDatabase;
        runMigrate(destDb, path.join(opts.worktreePath, "drizzle", "sqlite"));
      } catch (err) {
        // Non-fatal: createClient() will attempt a migrate on first getDb().
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(
          { tag: "worktree-bootstrap", op: "fresh_db_migrate_failed", err },
          `worktree fresh-DB migrate failed: ${msg}`,
        );
      }
    }
  }
}

/** Deterministic hash → port in [PORT_RANGE_START, PORT_RANGE_START + SIZE). */
export function hashPort(worktreePath: string): number {
  const buf = crypto.createHash("sha256").update(worktreePath).digest();
  const n = buf.readUInt32BE(0);
  return PORT_RANGE_START + (n % PORT_RANGE_SIZE);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE" || e.code === "EACCES") resolve(false);
      else resolve(false);
    });
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

/** Hashed port first; scan forward through the range on collision; throw
 *  when every port in the range is taken. */
export async function pickPort(worktreePath: string): Promise<number> {
  const start = hashPort(worktreePath);
  for (let i = 0; i < PORT_RANGE_SIZE; i++) {
    const offset = (start - PORT_RANGE_START + i) % PORT_RANGE_SIZE;
    const port = PORT_RANGE_START + offset;
    if (await isPortFree(port)) return port;
  }
  throw new Error(
    `worktree-bootstrap: all ports ${PORT_RANGE_START}..${PORT_RANGE_START + PORT_RANGE_SIZE - 1} are in use`,
  );
}

function tryGit(
  cwd: string,
  args: string[],
): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

export interface UpdateLaunchOpts {
  worktreePath: string;
  port: number;
  /** Electron CDP port for the `Libi Electron` config. Omit to leave it. */
  cdpPort?: number;
}

/** Read the worktree's .claude/launch.json, rewrite the `Libi` config's
 *  `port` (Next dev server) and — when `cdpPort` is given — the
 *  `Libi Electron` config's `port` (Electron remote-debugging endpoint) to
 *  the resolved values (atomic), and set `--skip-worktree` on the file so
 *  the per-worktree edit doesn't pollute `git status`. Idempotent +
 *  best-effort (silently no-ops if the file is missing or git is
 *  unavailable). */
export function updateLaunchJson(opts: UpdateLaunchOpts): void {
  const file = path.join(opts.worktreePath, LAUNCH_JSON_REL);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return; // file missing → nothing to do
  }
  let parsed: { configurations?: Array<{ name?: string; port?: number }> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return; // malformed → leave as-is
  }
  const nextCfg = parsed.configurations?.find((c) => c?.name === "Libi");
  const electronCfg = parsed.configurations?.find((c) => c?.name === "Libi Electron");

  let changed = false;
  if (nextCfg && nextCfg.port !== opts.port) {
    nextCfg.port = opts.port;
    changed = true;
  }
  if (typeof opts.cdpPort === "number" && electronCfg && electronCfg.port !== opts.cdpPort) {
    electronCfg.port = opts.cdpPort;
    changed = true;
  }

  if (!changed) {
    // Already correct — only ensure the skip-worktree bit is set.
    ensureSkipWorktree(opts.worktreePath, LAUNCH_JSON_REL);
    return;
  }
  const next = JSON.stringify(parsed, null, 2) + "\n";
  const tmpFile = `${file}.tmp`;
  fs.writeFileSync(tmpFile, next, "utf-8");
  fs.renameSync(tmpFile, file);
  ensureSkipWorktree(opts.worktreePath, LAUNCH_JSON_REL);
}

export interface UpdateMcpOpts {
  worktreePath: string;
  cdpPort: number;
}

/** Rewrite the worktree's `.mcp.json` so the bundled `@playwright/mcp`
 *  `--cdp-endpoint` points at THIS worktree's CDP port (instead of the
 *  hardcoded 9222 every worktree ships with). Without this, a Claude Code
 *  session opened in the worktree attaches its playwright client to whatever
 *  Electron happens to own 9222 (often the canonical checkout's), not the
 *  worktree's. Atomic, skip-worktree, best-effort. */
export function updateMcpJson(opts: UpdateMcpOpts): void {
  const file = path.join(opts.worktreePath, MCP_JSON_REL);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return; // no .mcp.json → nothing to do
  }
  let parsed: {
    mcpServers?: Record<string, { args?: string[] }>;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const endpoint = `http://localhost:${opts.cdpPort}`;
  let changed = false;
  for (const server of Object.values(parsed.mcpServers ?? {})) {
    if (!Array.isArray(server.args)) continue;
    server.args = server.args.map((a) => {
      if (typeof a === "string" && a.startsWith("--cdp-endpoint=")) {
        const replaced = `--cdp-endpoint=${endpoint}`;
        if (replaced !== a) changed = true;
        return replaced;
      }
      return a;
    });
  }
  if (!changed) {
    ensureSkipWorktree(opts.worktreePath, MCP_JSON_REL);
    return;
  }
  const next = JSON.stringify(parsed, null, 2) + "\n";
  const tmpFile = `${file}.tmp`;
  fs.writeFileSync(tmpFile, next, "utf-8");
  fs.renameSync(tmpFile, file);
  ensureSkipWorktree(opts.worktreePath, MCP_JSON_REL);
}

/** `git update-index --skip-worktree <rel>` iff (a) we're in a git repo,
 *  (b) the file is tracked, and (c) the bit isn't already set. All
 *  failures are swallowed — this is opportunistic. */
function ensureSkipWorktree(cwd: string, rel: string): void {
  const ls = tryGit(cwd, ["ls-files", "-v", "--", rel]);
  if (!ls.ok || !ls.stdout.trim()) return; // not tracked or not a repo
  const firstChar = ls.stdout.trim().charAt(0);
  if (firstChar === "S") return; // already skip-worktree
  tryGit(cwd, ["update-index", "--skip-worktree", "--", rel]);
}

export interface RegisterCanonicalOpts {
  /** The canonical checkout root (owner of `.git/`). */
  canonicalRoot: string;
  /** Absolute path to this worktree. */
  worktreePath: string;
  /** Worktree key (basename, possibly hash-suffixed). */
  key: string;
  /** Worktree's Next dev port. */
  port: number;
  /** Worktree's Electron CDP port. */
  cdpPort: number;
}

/** Field stamped on the configs we inject so we can find + prune them later. */
const WORKTREE_CONFIG_KEY = "libiWorktree";

/**
 * Register (or refresh) two launch configs in the CANONICAL repo's
 * `.claude/launch.json` — `Libi (<key>)` (Next dev) + `Libi Electron (<key>)`
 * (Electron) — whose `runtimeArgs` point at THIS worktree's absolute entry
 * scripts and ports. This is what lets a `preview_start` run from the canonical
 * checkout actually launch the worktree instead of reusing the canonical's own
 * `Libi` server.
 *
 * Entries carry absolute, machine-local paths, so they must never be committed:
 * the file is marked `--skip-worktree`. Stale entries (worktree dir gone) are
 * pruned on every run. Best-effort: silently no-ops when the file is missing.
 */
export function registerCanonicalLaunchConfigs(opts: RegisterCanonicalOpts): void {
  const file = path.join(opts.canonicalRoot, LAUNCH_JSON_REL);
  let parsed: { configurations?: Array<Record<string, unknown>>; version?: string };
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return; // missing / malformed — don't fabricate one
  }
  if (!Array.isArray(parsed.configurations)) return;

  const mkEntry = (name: string, scriptRel: string[], port: number) => ({
    name,
    runtimeExecutable: "node",
    runtimeArgs: [path.join(opts.worktreePath, ...scriptRel)],
    port,
    autoPort: false,
    [WORKTREE_CONFIG_KEY]: opts.key,
  });

  const kept = parsed.configurations.filter((c) => {
    const wt = c?.[WORKTREE_CONFIG_KEY];
    if (typeof wt !== "string") return true; // not one of ours — keep
    if (wt === opts.key) return false; // replace our own entries
    // Prune entries whose worktree no longer exists. The embedded path is
    // `<wtPath>/bin/libi.js` or `<wtPath>/scripts/dev-electron.js`.
    const args = c.runtimeArgs;
    const arg0 = Array.isArray(args) ? args[0] : null;
    if (typeof arg0 === "string") {
      const wtPath = path.dirname(path.dirname(arg0));
      if (!fs.existsSync(wtPath)) return false;
    }
    return true;
  });

  const existing = JSON.stringify(parsed.configurations);
  parsed.configurations = [
    ...kept,
    mkEntry(`Libi (${opts.key})`, ["bin", "libi.js"], opts.port),
    mkEntry(`Libi Electron (${opts.key})`, ["scripts", "dev-electron.js"], opts.cdpPort),
  ];

  if (JSON.stringify(parsed.configurations) === existing) {
    ensureSkipWorktree(opts.canonicalRoot, LAUNCH_JSON_REL);
    return; // no change
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
  ensureSkipWorktree(opts.canonicalRoot, LAUNCH_JSON_REL);
}

/** One worktree `Libi Electron (<key>)` launch config that `dev-electron.js`
 *  can forward to. `scriptPath` is the absolute `<worktree>/scripts/dev-electron.js`. */
export interface ForwardTarget {
  key: string;
  scriptPath: string;
}

export interface ForwardDeps {
  /** Parse the canonical `.claude/launch.json`, or null if missing/malformed. */
  readLaunchJson: () => { configurations?: Array<Record<string, unknown>> } | null;
  /** Does this absolute path exist on disk? (Used to skip pruned worktrees.) */
  exists: (p: string) => boolean;
  /** Optional sink for the ">1 worktree, ambiguous" notice. */
  warn?: (msg: string) => void;
}

/**
 * Decide whether a canonical-checkout `dev-electron.js` boot should FORWARD to
 * a worktree's dev-electron instead of booting canonical code.
 *
 * `registerCanonicalLaunchConfigs` registers a `Libi Electron (<key>)` config
 * (tagged `WORKTREE_CONFIG_KEY`, `runtimeArgs[0] = <worktree>/scripts/dev-electron.js`)
 * for every active worktree. When EXACTLY ONE such config still exists on disk,
 * a generic `preview_start("Libi Electron")` from the canonical checkout should
 * boot THAT worktree (the overwhelmingly common single-worktree-dev case) — this
 * closes the "preview silently ran main code" footgun. With 0 we boot canonical;
 * with 2+ it's ambiguous, so we boot canonical and `warn()` the available names.
 * Pure (filesystem injected) so it's unit-tested in isolation.
 */
export function resolveCanonicalForwardTarget(
  canonicalRoot: string,
  deps: ForwardDeps,
): ForwardTarget | null {
  const cfg = deps.readLaunchJson();
  if (!cfg || !Array.isArray(cfg.configurations)) return null;
  const devElectronRel = path.join("scripts", "dev-electron.js");
  const targets: ForwardTarget[] = [];
  for (const c of cfg.configurations) {
    const key = c?.[WORKTREE_CONFIG_KEY];
    const args = c?.runtimeArgs;
    const arg0 = Array.isArray(args) ? args[0] : null;
    if (typeof key !== "string" || typeof arg0 !== "string") continue;
    if (!arg0.endsWith(devElectronRel)) continue; // only the Electron config
    const wtPath = path.dirname(path.dirname(arg0));
    if (path.resolve(wtPath) === path.resolve(canonicalRoot)) continue; // not self
    if (!deps.exists(arg0)) continue; // pruned / dead worktree
    targets.push({ key, scriptPath: arg0 });
  }
  if (targets.length === 1) return targets[0];
  if (targets.length > 1 && deps.warn) {
    deps.warn(
      `${targets.length} worktrees registered — not auto-forwarding. Use one of: ` +
        targets.map((t) => `"Libi Electron (${t.key})"`).join(", "),
    );
  }
  return null;
}

export interface PruneOpts {
  /** Root containing per-worktree home dirs (default WORKTREE_HOMES_ROOT). */
  root?: string;
  /** Never prune this key. */
  currentKey: string;
}

/** Scan the worktree-homes root and delete homes whose recorded
 *  worktreePath no longer resolves on disk. Defensive: every per-home
 *  failure is caught and skipped — pruning must never throw. */
export function pruneOrphans(opts: PruneOpts): void {
  const root = opts.root ?? WORKTREE_HOMES_ROOT;
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return; // root not present yet → nothing to prune
  }
  for (const key of entries) {
    if (key === opts.currentKey) continue;
    const home = path.join(root, key);
    try {
      const metaRaw = fs.readFileSync(
        path.join(home, META_FILENAME),
        "utf-8",
      );
      const meta = JSON.parse(metaRaw) as { worktreePath?: string };
      if (!meta.worktreePath || typeof meta.worktreePath !== "string") continue;
      if (!fs.existsSync(meta.worktreePath)) {
        fs.rmSync(home, { recursive: true, force: true });
        continue;
      }
      // Also prune when the path exists but is no longer a git checkout.
      if (!tryGit(meta.worktreePath, ["rev-parse", "--git-dir"]).ok) {
        fs.rmSync(home, { recursive: true, force: true });
      }
    } catch {
      // malformed meta / permission error / etc — skip, do not delete
      continue;
    }
  }
}

export interface ResolveOpts {
  /** Path to walk up looking for `.git` (the libi package's __dirname).
   *  Defaults to `process.cwd()`. */
  startPath?: string;
  /** Path passed to `git rev-parse` for worktree detection. Defaults to
   *  `process.cwd()`. Lets tests target a synthetic worktree dir. */
  cwd?: string;
  /** Canonical libi root. Default `~/.libi`. Overridable for tests. */
  libiRoot?: string;
  /** Env to read LIBI_HOME / LIBI_PORT overrides from. Default
   *  `process.env`. Pass `{}` explicitly in tests to isolate from the
   *  vitest global setup (which forces LIBI_HOME). */
  env?: NodeJS.ProcessEnv;
  /** Time function (testability). */
  now?: () => string;
}

export interface ResolvedEnv {
  /** New LIBI_HOME, omitted if user already set it or detection skipped. */
  libiHome?: string;
  /** Resolved port, omitted if user already set LIBI_PORT or detection skipped. */
  port?: number;
  /** Companion Electron CDP port (derived 1:1 from `port`). Omitted when
   *  `port` is omitted (user override / not a worktree). */
  cdpPort?: number;
  /** Worktree basename key (e.g. `review-long-task-progress-plan`).
   *  Omitted when not in a worktree. Exported by `bin/libi.js` as
   *  `LIBI_WORKTREE_NAME` so the running server can surface it in the UI. */
  worktreeName?: string;
  /** Env vars parsed from the canonical repo's `.env` / `.env.local` files,
   *  for the caller to merge into the spawned process (shell exports win).
   *  Empty / omitted when no canonical dotenv files were found. */
  envOverrides?: Record<string, string>;
  /** Which canonical-repo dotenv files contributed to `envOverrides`
   *  (basenames, e.g. ".env.local"). Surfaced in the banner. */
  envFiles?: string[];
  /** One-line dev banner the caller prints to stderr; omitted when {}. */
  logLine?: string;
}

/** Minimal dotenv parser: KEY=value per line, supports `#` comments, blank
 *  lines, surrounding double- or single-quotes (stripped), and trailing
 *  whitespace. NO shell expansion (no `$VAR`, no command substitution).
 *  Stops at the first `=` of each line so values can contain `=` themselves. */
export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const CANONICAL_DOTENV_FILES = [".env.local", ".env"] as const;

/** Walk the canonical repo root (parent of `git --git-common-dir`) for
 *  dotenv files and return their merged contents + the basenames that
 *  contributed. Earlier files in `CANONICAL_DOTENV_FILES` win on collision
 *  (so `.env.local` overrides `.env`, matching Next.js precedence).
 *  Returns `{ envOverrides: {}, envFiles: [] }` when none exist. */
export function loadCanonicalDotenv(canonicalRoot: string): {
  envOverrides: Record<string, string>;
  envFiles: string[];
} {
  const envOverrides: Record<string, string> = {};
  const envFiles: string[] = [];
  // Iterate lowest-precedence first; later writes overwrite earlier ones.
  for (const name of [...CANONICAL_DOTENV_FILES].reverse()) {
    const fp = path.join(canonicalRoot, name);
    if (!fs.existsSync(fp)) continue;
    let content: string;
    try {
      content = fs.readFileSync(fp, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseDotenv(content);
    if (Object.keys(parsed).length === 0) continue;
    Object.assign(envOverrides, parsed);
    envFiles.unshift(name); // surface in precedence order in the banner
  }
  return { envOverrides, envFiles };
}

/** Resolve the canonical repo root (the checkout that owns `.git/`) by
 *  asking git for `--git-common-dir` and taking its parent. Returns null
 *  on any git failure. Pure: no side effects. */
export function resolveCanonicalRoot(cwd: string): string | null {
  try {
    const gitCommon = execFileSync(
      "git",
      ["rev-parse", "--git-common-dir"],
      { cwd, encoding: "utf-8" },
    ).trim();
    const abs = path.isAbsolute(gitCommon)
      ? gitCommon
      : path.resolve(cwd, gitCommon);
    return path.dirname(abs);
  } catch {
    return null;
  }
}

/** Top-level entry. See spec for details. Never throws — falls back to
 *  `{}` on any internal failure, logging the reason. */
export async function resolveWorktreeEnv(
  opts: ResolveOpts = {},
): Promise<ResolvedEnv> {
  const startPath = opts.startPath ?? process.cwd();
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const libiRoot = opts.libiRoot ?? path.join(os.homedir(), ".libi");

  if (!inDevCheckout(startPath)) return {};
  if (!isLinkedWorktree(cwd)) return {};

  try {
    const worktreePath = path.resolve(cwd);

    // Snapshot existing homes so resolveKey can detect basename collisions.
    const homesRoot = path.join(libiRoot, "worktrees");
    const existing: ExistingHome[] = [];
    try {
      for (const entry of fs.readdirSync(homesRoot)) {
        try {
          const meta = JSON.parse(
            fs.readFileSync(
              path.join(homesRoot, entry, META_FILENAME),
              "utf-8",
            ),
          ) as { worktreePath?: string };
          if (typeof meta.worktreePath === "string") {
            existing.push({ key: entry, worktreePath: meta.worktreePath });
          }
        } catch {
          /* ignore unreadable */
        }
      }
    } catch {
      /* homesRoot not present yet — first run */
    }
    const key = resolveKey(worktreePath, existing);
    const home = path.join(homesRoot, key);

    const useHome = !env.LIBI_HOME;
    const usePort = !env.LIBI_PORT;

    if (useHome) {
      setupWorktreeHome({ home, worktreePath, libiRoot });
    }
    const port = usePort ? await pickPort(worktreePath) : undefined;
    const cdpPort = typeof port === "number" ? cdpPortForNextPort(port) : undefined;
    if (usePort && typeof port === "number") {
      updateLaunchJson({ worktreePath, port, cdpPort });
      if (typeof cdpPort === "number") updateMcpJson({ worktreePath, cdpPort });
    }
    pruneOrphans({ root: homesRoot, currentKey: key });

    // Load canonical-repo dotenv files (`.env.local`, `.env`) so the worktree
    // process inherits the same keys the canonical libi would auto-load via
    // Next.js. Caller merges these into the spawned env with shell exports
    // taking precedence — see bin/libi.js.
    let envOverrides: Record<string, string> = {};
    let envFiles: string[] = [];
    const canonicalRoot = resolveCanonicalRoot(cwd);
    if (canonicalRoot) {
      const loaded = loadCanonicalDotenv(canonicalRoot);
      envOverrides = loaded.envOverrides;
      envFiles = loaded.envFiles;

      // Register worktree-specific launch configs in the canonical repo so a
      // `preview_start` run from there can target THIS worktree (instead of
      // reusing the canonical's own `Libi` server on the default port).
      if (usePort && typeof port === "number" && typeof cdpPort === "number") {
        registerCanonicalLaunchConfigs({ canonicalRoot, worktreePath, key, port, cdpPort });
      }
    }

    const out: ResolvedEnv = {};
    if (useHome) out.libiHome = home;
    if (usePort && typeof port === "number") {
      out.port = port;
      if (typeof cdpPort === "number") out.cdpPort = cdpPort;
    }
    // Always surface the worktree key (independent of useHome) so the UI can
    // badge the brand even when the user explicitly set LIBI_HOME themselves.
    out.worktreeName = key;
    if (Object.keys(envOverrides).length > 0) {
      out.envOverrides = envOverrides;
      out.envFiles = envFiles;
    }
    const envFilesTag =
      envFiles.length > 0 ? ` +envFiles=${envFiles.join(",")}` : "";
    const cdpTag = usePort && typeof cdpPort === "number" ? ` cdp=${cdpPort}` : "";
    out.logLine = `[libi/dev] worktree=${key} home=${useHome ? home : "(env override)"} port=${usePort ? port : "(env override)"}${cdpTag} (shared: ${SHARED_LINKS.join(", ")})${envFilesTag}`;
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      { tag: "worktree-bootstrap", op: "resolve_env_failed", err },
      `worktree-bootstrap failed: ${msg}; falling back to default LIBI_HOME / PORT`,
    );
    return {};
  }
}
