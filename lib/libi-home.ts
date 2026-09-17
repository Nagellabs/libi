import os from "os";
import path from "path";
import fs from "fs";

/**
 * Resolve the Libi data root directory.
 *
 * Resolution order:
 * 1. LIBI_HOME env var
 * 2. ~/.libi/config.json libiHome key (written by Settings UI)
 * 3. Default: ~/.libi
 */
export function getLibiHome(): string {
  if (process.env.LIBI_HOME) return process.env.LIBI_HOME;

  // Check config.json at the default location for a custom path
  const defaultHome = path.join(os.homedir(), ".libi");
  const configPath = path.join(defaultHome, "config.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (typeof config.libiHome === "string" && config.libiHome) {
      return config.libiHome;
    }
  } catch {
    // config.json doesn't exist or is invalid — use default
  }

  return defaultHome;
}

export function getLibiDbPath(): string {
  return path.join(getLibiHome(), "libi.sqlite");
}

export function getLibiStorageDir(): string {
  return path.join(getLibiHome(), "storage");
}

export function getLibiAgentDir(): string {
  return path.join(getLibiHome(), "agent");
}

export function getLibiBinDir(): string {
  return path.join(getLibiHome(), "bin");
}

export function getLibiModelsDir(): string {
  return path.join(getLibiHome(), "models");
}

export function getLibiPortFile(): string {
  return path.join(getLibiHome(), "port");
}

/**
 * Resolve the port to publish in `<LIBI_HOME>/port`.
 *
 * This file is the discovery mechanism for processes with no parent server to
 * name theirs — a stdio MCP a user's own agent launched, a hand-run
 * `serve-mcp-http`, anything started from the in-app terminal (see
 * `getCurrentPort()` below). The server's in-process callers (the tracking and
 * analysis runners, the terminal WebSocket) and the aggregator it launches
 * resolve it through `LIBI_SERVER_PORT` instead. Publishing a
 * port the server is not listening on is worse than publishing nothing: on a
 * machine running more than one libi it silently routes an MCP child at a
 * DIFFERENT instance's database.
 *
 * Every entry point is therefore required to put the REAL bound port in the
 * env before Category B runs — `lib/cli/studio.ts#runProductionServer` sets
 * `PORT` from the CLI flag before `next().prepare()`, and
 * `electron/main.ts#startNextServer` binds its ephemeral port BEFORE preparing
 * Next and sets `PORT`/`LIBI_PORT` from `server.address()`. The literal
 * fallback below only survives as a last resort for `next dev` invoked outside
 * both paths; reaching it is a bug, so Category B logs it loudly rather than
 * writing it silently (which is exactly how the packaged app shipped a wrong
 * port).
 *
 * Category B also puts the same value in the server's own environment as
 * `LIBI_SERVER_PORT`, and the aggregator supervisor hands it to every launch
 * (`lib/server/lifecycle/mcp-http-child.ts`), so the server, its children and
 * the file can never disagree about which server this process is.
 */
export function resolvePortToPublish(
  env: NodeJS.ProcessEnv = process.env,
): { port: string; source: "PORT" | "LIBI_PORT" | "default" } {
  if (env.PORT) return { port: env.PORT, source: "PORT" };
  if (env.LIBI_PORT) return { port: env.LIBI_PORT, source: "LIBI_PORT" };
  return { port: "3456", source: "default" };
}

/**
 * The port of the libi server this process belongs to.
 *
 * Category B sets it in the server's own environment when it publishes
 * `<LIBI_HOME>/port`, so the server's in-process callers and the processes it
 * spawns inherit it; the aggregator supervisor also hands it to every launch
 * explicitly (`mcp-http-child.ts`). The in-app terminal strips it
 * (`lib/terminal/manager.ts`): what a user starts there is theirs.
 *
 * `<LIBI_HOME>/port` is shared by every libi on the home, and the last one to
 * boot owns it. A second desktop launch on a fresh Windows install rewrote it
 * and then exited, and the FIRST window's aggregator, reading only the file,
 * sent every libi tool call to the dead port while its own server was fine. A
 * process that knows its server does not consult the shared file at all.
 */
export const LIBI_SERVER_PORT_ENV = "LIBI_SERVER_PORT";

/**
 * Get the current server port.
 *
 * `LIBI_SERVER_PORT` wins: this process is a libi server, or was started by
 * one, and that server is the answer. Everything without a server of its own
 * (a stdio MCP launched by a user's own agent, a hand-run `serve-mcp-http`,
 * anything started from the in-app terminal) reads the port file each time
 * (so it follows a server restart onto a new port), then falls back to the
 * LIBI_PORT env var, then to the default 3456, if the file doesn't exist.
 *
 * Throws if the chosen value cannot be parsed as a finite integer — surfaces
 * misconfigured ports early instead of constructing `http://127.0.0.1:NaN`
 * URLs downstream.
 */
export function getCurrentPort(): number {
  let raw: string;
  const parentServerPort = process.env[LIBI_SERVER_PORT_ENV];
  if (parentServerPort) {
    raw = parentServerPort.trim();
  } else {
    try {
      raw = fs.readFileSync(getLibiPortFile(), "utf-8").trim();
    } catch {
      raw = process.env.LIBI_PORT ?? "3456";
    }
  }
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port)) {
    throw new Error(`getCurrentPort: could not parse port value ${JSON.stringify(raw)}`);
  }
  return port;
}

/**
 * Remove a discovery file (`port`, `mcp-port`) only while it still names
 * `port` — the one this process published. Returns whether it removed it.
 *
 * Two libi processes on one home share both files, and the one that booted
 * last owns them. An instance that exits must leave the other's alone, or
 * that instance's MCP children lose their server. A missing file, an
 * unreadable one, or a `null` port (nothing was ever published) removes
 * nothing. The read and the unlink are not atomic; a rewrite landing between
 * them is the one case this cannot see.
 */
export function removePortFileIfOwned(file: string, port: number | string | null | undefined): boolean {
  if (port === null || port === undefined) return false;
  const own = Number.parseInt(String(port), 10);
  if (!Number.isFinite(own)) return false;
  let named: number;
  try {
    named = Number.parseInt(fs.readFileSync(file, "utf-8").trim(), 10);
  } catch {
    return false;
  }
  if (named !== own) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export function getMcpPortFile(): string {
  return path.join(getLibiHome(), "mcp-port");
}

/**
 * Warn through `serverLogger` WITHOUT a top-level import of `@/lib/logger`.
 *
 * The logger calls `ensureLibiDirs()` from this module while it is being
 * imported, so a static import here would form an init cycle. Everything this
 * module logs is best-effort and fire-and-forget, so a dynamic import is the
 * right shape: never `console.*`, never on the critical path.
 */
function lazyWarn(fields: Record<string, unknown>, message: string): void {
  void import("@/lib/logger")
    .then(({ serverLogger }) => serverLogger.warn(fields, message))
    .catch(() => {
      /* logging is best-effort — swallow */
    });
}

/**
 * The aggregator's default port. It is deliberately a FIXED number rather
 * than something derived from the studio port: the packaged Electron app
 * binds the studio on an ephemeral port (`lib/server/next-server.ts`), so a
 * derived aggregator port moves on every launch — and the URL `libi connect`
 * wrote into the user's `~/.claude.json` would die at the next app start.
 */
export const DEFAULT_MCP_PORT = 3457;

/**
 * The environment variable the supervisor hands each aggregator launch its
 * `/healthz` identity token in (`lib/server/lifecycle/mcp-http-child.ts`), and
 * that the aggregator reads to echo it back (`mcp/http/index.ts`). It lives
 * here because both sides already import this module and neither may import
 * the other.
 */
export const MCP_HEALTH_TOKEN_ENV = "LIBI_MCP_HEALTH_TOKEN";

/**
 * Set to `1` in every aggregator launch's environment by the same supervisor.
 * Not a secret, so unlike the health token the aggregator's entry never deletes
 * it: code that must know it runs inside the supervised MCP child
 * (`mcp/skills/installs.ts`) reads it whenever it asks, whatever loaded first.
 */
export const MCP_SUPERVISED_ENV = "LIBI_MCP_SUPERVISED";

/**
 * A port-shaped `LIBI_MCP_PORT` (or `--port`) value, or `null` when it is unset
 * or unusable.
 *
 * The single validator every port seam shares. `resolveMcpHttpPort` and
 * `pickMcpHttpPort` used to branch on the RAW value's truthiness, so
 * `LIBI_MCP_PORT=abc` read as "the user pinned a port" and short-circuited the
 * whole fallback chain to the default without probing anything.
 */
export function parseMcpPortEnv(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
  return parsed;
}

/**
 * The port the HTTP MCP aggregator (`libi serve-mcp-http`) is EXPECTED on:
 * `LIBI_MCP_PORT` when set and valid, else `DEFAULT_MCP_PORT`.
 *
 * This is the "libi is not running" answer — the live port always comes from
 * `<LIBI_HOME>/mcp-port`, which `startMcpHttpChild` publishes after health.
 * `pickMcpHttpPort` (lib/server/lifecycle/mcp-http-child.ts) is what may fall
 * back to another port when this one is taken.
 */
export function resolveMcpHttpPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LIBI_MCP_PORT;
  const parsed = parseMcpPortEnv(raw);
  if (parsed !== null) return parsed;
  if (raw) {
    // A NaN here used to reach `listen(NaN)` — an OS-assigned port that every
    // other consumer computing the same value disagreed with, with no error
    // anywhere. This is the single discovery seam for every agent surface.
    lazyWarn(
      { tag: "mcp-http", op: "bad_mcp_port_env", value: raw, fallback: DEFAULT_MCP_PORT },
      "LIBI_MCP_PORT is not a port number; using the default",
    );
  }
  return DEFAULT_MCP_PORT;
}

/** Live aggregator port: the mcp-port file while libi runs, else the resolver. */
export function getCurrentMcpPort(): number {
  try {
    const raw = fs.readFileSync(getMcpPortFile(), "utf-8").trim();
    const port = Number.parseInt(raw, 10);
    if (Number.isFinite(port)) return port;
  } catch { /* not running */ }
  return resolveMcpHttpPort();
}

export function getLibiLogDir(): string {
  return path.join(getLibiHome(), "logs");
}

export function getLibiSkillsDir(): string {
  return path.join(getLibiHome(), "skills");
}

/** The user's cross-session memories file, injected into agent instructions. */
export function getLibiMemoriesPath(): string {
  return path.join(getLibiHome(), "memories.md");
}

/** Holds the user's instructions override (instructions.md) + .base.md snapshot. */
export function getLibiInstructionsDir(): string {
  return path.join(getLibiHome(), "instructions");
}

/**
 * Root that `lib/mcp/bundled-install.ts` (deleted 2026-09-08) used to
 * populate with a generated `package.json` + `node_modules/` of bundled MCP
 * packages. Nothing writes `~/.libi/node_modules` any more; the path is
 * kept for callers that still look for a pre-existing install
 * (`mcp/registry/local-bin-resolver.ts`).
 */
export function getLibiNodeModulesRoot(): string {
  return getLibiHome();
}

/**
 * A real bundled-skills directory always has at least one `<name>/SKILL.md`
 * child. `scripts/build-cli.js` compiles `mcp/skills/*.ts` (loader, writer,
 * digest, registry) to `dist-cli/mcp/skills/` — a directory that exists, has
 * the right NAME, and holds zero `SKILL.md` files. Walking up from
 * `__dirname` in compiled mode hits that decoy (`dist-cli/lib/` → one hop up
 * to `dist-cli/mcp/skills`) before the real `<pkg>/mcp/skills` is ever tried,
 * so every bundled-skill read from the MCP child (cwd = `~/.libi/agent/`,
 * never the package root) silently resolved into an empty directory. Content
 * validation — not just candidate ORDER — is what makes this resolver safe
 * against any future decoy of the same shape, not only this one.
 */
function looksLikeBundledSkillsDir(dir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some(
    (entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "SKILL.md")),
  );
}

export function getBundledSkillsDir(): string {
  const candidates: string[] = [path.join(process.cwd(), "mcp", "skills")];

  // Walk up from this file's directory looking for a sibling mcp/skills.
  // Works whether the package is installed under node_modules or compiled in-tree.
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    candidates.push(path.join(dir, "mcp", "skills"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Electron sets process.resourcesPath at runtime — undefined elsewhere.
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, "app", "mcp", "skills"));
  }

  for (const candidate of candidates) {
    if (looksLikeBundledSkillsDir(candidate)) return candidate;
  }
  // Fall back to the cwd-based path so callers get a deterministic value
  // even when no candidate exists (matches prior behavior).
  return candidates[0];
}

/**
 * Best-effort `chmod`. Never throws — POSIX permission bits are meaningless
 * on Windows and some network filesystems reject `chmod`, and locking these
 * files down is a hardening nicety, not a correctness requirement. On failure
 * we log-and-continue so startup is never gated on it.
 */
function chmodBestEffort(target: string, mode: number, op: string): void {
  try {
    fs.chmodSync(target, mode);
  } catch (err) {
    lazyWarn(
      {
        tag: "libi-home",
        op,
        target,
        mode: mode.toString(8),
        err: err instanceof Error ? err.message : String(err),
      },
      "chmod failed while locking libi-home permissions (continuing)",
    );
  }
}

export function ensureLibiDirs(): void {
  const home = getLibiHome();
  // Create the data root private to the current user (0700). `mkdir` mode is
  // masked by the process umask, so we also chmod explicitly below — the
  // umask can otherwise leave group/other bits set.
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodBestEffort(home, 0o700, "chmod_home");

  for (const sub of ["storage", "agent", "bin", "models", "logs", "skills"]) {
    fs.mkdirSync(path.join(home, sub), { recursive: true });
  }

  // Lock any secret-bearing files that already exist. The SQLite DB holds MCP
  // server secrets / API keys; its -wal/-shm sidecars mirror that content; and
  // config.json holds the resolved data-root path. Each is 0600 (owner-only).
  const dbPath = getLibiDbPath();
  for (const secretFile of [
    dbPath,
    `${dbPath}-wal`,
    `${dbPath}-shm`,
    path.join(home, "config.json"),
  ]) {
    if (fs.existsSync(secretFile)) {
      chmodBestEffort(secretFile, 0o600, "chmod_secret_file");
    }
  }
}
