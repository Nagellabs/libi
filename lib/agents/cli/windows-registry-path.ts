import { execFile as nodeExecFile } from "node:child_process";
import { serverLogger as logger } from "@/lib/logger";
import { isWindows } from "@/lib/platform";

/**
 * Windows' fresh PATH, read from the registry — Windows' counterpart of the login-shell probe
 * (`login-shell-path.ts`), which has nothing to probe there.
 *
 * A process takes its environment when it starts, and an installer (uv's, a new Node's) writes the
 * PATH it extends into the registry, not into running processes. So libi, started before the
 * install, still has the old PATH, and so does every agent it starts from it (`lib/agents/agent-path.ts`):
 * the agent's MCP server can't find the launcher the user just installed. The registry holds the PATH a
 * process started NOW would get: the machine's `Path`, then the user's, each `%VAR%` expanded, the
 * order Windows itself builds a new process's PATH in.
 *
 * Two `reg query` calls, run together, bounded at REGISTRY_PATH_TIMEOUT_MS together. A value that is
 * not there (a user with no `Path` of their own) is empty, not a failure. A query that times out, or
 * fails any other way, fails the read: the caller keeps the PATH it has — "no answer" is never "an
 * empty PATH", so the last good read (if any) is left as it was. Every answer, a failure included, is
 * memoized for 5 s, so a burst of spawns reads the registry once and a `reg` that hangs (antivirus
 * hooking it) costs its 2 s at most once per 5 s. The failure is warned about once, when reads start
 * failing, and noted again when they recover. Never on another platform.
 */
export const REGISTRY_PATH_TIMEOUT_MS = 2_000;
const MEMO_MS = 5_000;

export const MACHINE_ENVIRONMENT_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
export const USER_ENVIRONMENT_KEY = "HKCU\\Environment";

/** `reg` exits 1 with this on stderr when the key or the value is not there. English only — see `queryPath`. */
const NOT_FOUND_RE = /unable to find the specified registry key or value/i;

export type RegQuery = (args: string[], timeoutMs: number) => Promise<string>;

export interface RegistryPathDeps {
  /** Runs `reg <args>` and resolves its stdout; rejects on a timeout or a failure. */
  runReg?: RegQuery;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  timeoutMs?: number;
}

let memo: { at: number; dirs: string[] | null } | null = null;
/** Whether the last read failed — so a failure is warned about once per run of them. */
let failing = false;
let inflight: Promise<string[] | null> | null = null;
let lastGood: string[] | null = null;

/** Tests only. */
export function __clearWindowsRegistryPathMemo(): void {
  memo = null;
  inflight = null;
  lastGood = null;
  failing = false;
}

/**
 * The folders the last successful registry read delivered, or null when none has in this process.
 * NEVER reads the registry — for callers that must not wait. Always null off Windows.
 */
export function lastWindowsRegistryPathDirs(): string[] | null {
  return lastGood;
}

const defaultRunReg: RegQuery = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    nodeExecFile("reg", args, { timeout: timeoutMs, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stderr: String(stderr ?? "") }));
        return;
      }
      resolve(String(stdout));
    });
  });

/** The data of the `Path` value in `reg query <key> /v Path` output, or null when there is none. */
export function parseRegQueryPath(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

/** `%NAME%` replaced by the variable's value, found case-insensitively as Windows does; an unknown one is left as written. */
export function expandWindowsEnv(value: string, env: Readonly<Record<string, string | undefined>>): string {
  const byUpper = new Map<string, string>();
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !byUpper.has(k.toUpperCase())) byUpper.set(k.toUpperCase(), v);
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => byUpper.get(name.toUpperCase()) ?? whole);
}

/** Every `NAME REG_SZ|REG_EXPAND_SZ value` line of a plain `reg query <key>` (no `/v`) dump, as a map. */
function parseRegQueryEnvironment(stdout: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/.exec(line);
    if (m) vars[m[1]] = m[2].trim();
  }
  return vars;
}

async function queryPath(runReg: RegQuery, key: string, timeoutMs: number): Promise<string> {
  try {
    return parseRegQueryPath(await runReg(["query", key, "/v", "Path"], timeoutMs)) ?? "";
  } catch (err) {
    const e = err as { code?: unknown; stderr?: unknown; killed?: boolean };
    // Exit 1, not killed: the value is not there, which is an answer. For HKCU\Environment specifically this holds
    // whatever stderr says — a user with no `Path` of their own is a normal case libi must not fail on, and
    // `NOT_FOUND_RE` only matches the English message; a localized Windows exits 1 with a translated one. For the
    // machine key, an unexpected exit 1 still needs the English match: HKLM\...\Environment not existing at all
    // would be a genuinely odd result worth surfacing as a failure rather than silently treated as "no PATH".
    if (e.code === 1 && !e.killed && (key === USER_ENVIRONMENT_KEY || NOT_FOUND_RE.test(String(e.stderr ?? "")))) return "";
    throw err;
  }
}

/**
 * The full Environment key's variables, for expansion only — never the source of truth for `Path` itself (that
 * stays `queryPath`, unchanged). Best-effort: any failure (including "not there") resolves to `{}` rather than
 * failing the read, since this only enriches `%VAR%` expansion.
 */
async function queryEnvironment(runReg: RegQuery, key: string, timeoutMs: number): Promise<Record<string, string>> {
  try {
    return parseRegQueryEnvironment(await runReg(["query", key], timeoutMs));
  } catch {
    return {};
  }
}

/**
 * Read the registry's PATH now (Windows only; null elsewhere, and when the read fails or times out).
 * A success becomes `lastWindowsRegistryPathDirs()`.
 */
export async function refreshWindowsRegistryPath(deps: RegistryPathDeps = {}): Promise<string[] | null> {
  if (!isWindows()) return null;
  const now = deps.now ?? Date.now;
  if (memo && now() - memo.at < MEMO_MS) return memo.dirs;
  if (inflight) return inflight;
  const runReg = deps.runReg ?? defaultRunReg;
  const env = deps.env ?? process.env;
  const timeoutMs = deps.timeoutMs ?? REGISTRY_PATH_TIMEOUT_MS;
  const started = now();
  inflight = (async (): Promise<string[] | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("registry PATH read timed out"), { killed: true })), timeoutMs);
      timer.unref?.();
    });
    try {
      const [machine, user, machineVars, userVars] = await Promise.race([
        Promise.all([
          queryPath(runReg, MACHINE_ENVIRONMENT_KEY, timeoutMs),
          queryPath(runReg, USER_ENVIRONMENT_KEY, timeoutMs),
          queryEnvironment(runReg, MACHINE_ENVIRONMENT_KEY, timeoutMs),
          queryEnvironment(runReg, USER_ENVIRONMENT_KEY, timeoutMs),
        ]),
        bound,
      ]);
      // The registry's OWN Environment values take precedence over this process's (possibly stale, pre-boot) env:
      // an nvm-windows / Volta install writes vars like NVM_HOME after libi started, so they are missing from
      // `env` but present in the very dump this read just fetched.
      const mergedEnv = { ...env, ...machineVars, ...userVars };
      const dirs: string[] = [];
      for (const raw of `${machine};${user}`.split(";")) {
        const dir = expandWindowsEnv(raw.trim(), mergedEnv);
        // `reg.exe` writes the console's OEM codepage, decoded here as utf8 (see `defaultRunReg`); a non-ASCII
        // folder garbles into U+FFFD. Drop just that folder rather than fail the whole read.
        if (dir && !dir.includes("�") && !dirs.includes(dir)) dirs.push(dir);
      }
      memo = { at: now(), dirs };
      lastGood = dirs;
      if (failing) {
        failing = false;
        logger.info({ tag: "agent-cli", op: "registry_path_read_recovered" }, "the registry's PATH can be read again");
      }
      return dirs;
    } catch (err) {
      const e = err as { killed?: boolean; code?: unknown };
      memo = { at: now(), dirs: null };
      if (!failing) {
        failing = true;
        // Counts only: no PATH, no registry text.
        logger.warn(
          { tag: "agent-cli", op: "registry_path_read_failed", timedOut: e.killed === true, code: typeof e.code === "number" ? e.code : null, ms: now() - started },
          "could not read the PATH from the registry; agents keep this process's PATH",
        );
      }
      return null;
    } finally {
      clearTimeout(timer);
      inflight = null;
    }
  })();
  return inflight;
}
