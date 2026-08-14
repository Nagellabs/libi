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

/**
 * The connected (external) agent directory from `--connect-agent`, or null.
 * Presence of LIBI_CONNECT_AGENT_DIR IS the connect-agent mode signal —
 * there is no separate mode flag.
 */
export function getConnectedAgentDir(): string | null {
  const dir = process.env.LIBI_CONNECT_AGENT_DIR;
  if (!dir) return null;
  return path.resolve(dir);
}

/**
 * Directories agent-config prep and regeneration must write: always the
 * default agent dir (in-app surfaces run there); plus the connected dir in
 * connect-agent mode. Deduplicated when they coincide.
 */
export function getAgentDirWriteTargets(): string[] {
  const targets = [getLibiAgentDir()];
  const connected = getConnectedAgentDir();
  if (connected && connected !== targets[0]) targets.push(connected);
  return targets;
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
 * Get the current server port. Reads from the port file each time
 * so the MCP process picks up server restarts on a new port.
 * Falls back to LIBI_PORT env var, then to default 3456, if the file
 * doesn't exist.
 *
 * Throws if the port file or env var contains a value that cannot be
 * parsed as a finite integer — surfaces misconfigured ports early instead
 * of constructing `http://127.0.0.1:NaN` URLs downstream.
 */
export function getCurrentPort(): number {
  let raw: string;
  try {
    raw = fs.readFileSync(getLibiPortFile(), "utf-8").trim();
  } catch {
    raw = process.env.LIBI_PORT ?? "3456";
  }
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port)) {
    throw new Error(`getCurrentPort: could not parse port value ${JSON.stringify(raw)}`);
  }
  return port;
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
 * Root for bundled-MCP npm installs. Contains a generated `package.json`
 * + `node_modules/`. See `lib/mcp/bundled-install.ts`.
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
    // Lazy-load the logger so this low-level bootstrap module never imports
    // `@/lib/logger` at module top level — the logger calls `ensureLibiDirs()`
    // on import, so a static import here would form an init cycle. Logging is
    // best-effort and fire-and-forget.
    void import("@/lib/logger")
      .then(({ serverLogger }) => {
        serverLogger.warn(
          {
            tag: "libi-home",
            op,
            target,
            mode: mode.toString(8),
            err: err instanceof Error ? err.message : String(err),
          },
          "chmod failed while locking libi-home permissions (continuing)",
        );
      })
      .catch(() => {
        /* logging is best-effort — swallow */
      });
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
