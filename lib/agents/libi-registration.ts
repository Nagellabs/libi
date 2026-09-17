import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serverLogger as logger } from "@/lib/logger";
import { getLibiAgentDir } from "@/lib/libi-home";
import { getRegistrationMcpPort } from "@/lib/server/lifecycle/mcp-http-handle";
import { libiCodexEntryShape, type CodexMcpListEntry, type LibiCodexEntryShape } from "@/lib/codex-config/codex-cli";
import { __clearCodexMcpListing, readCodexMcpListing, type CodexMcpListing } from "@/lib/agents/codex-mcp-listing";
import { LIBI_MCP_ENTRY_NAME } from "@/lib/mcp/agent-surface";
import { resolveAgentCli, type ResolvedAgentCli } from "@/lib/agents/cli/resolve";
import { spawnViaNodeIfScript, type ResolvedBin } from "@/lib/agents/cli/spawn-shape";
import type { SetupAgentId } from "@/lib/agents/setup/commands";

/**
 * Is libi registered in the user's OWN agent config, and on which port?
 *
 * Read-only, and never returns a header, env or key value — only the entry's
 * url. Claude: its config file (user scope first, then the libi agent dir's
 * local scope). Codex: `codex mcp list --json`, run only through the CLI
 * `resolveAgentCli` found, the way it ran that CLI, and shared with provider
 * detection (`lib/agents/codex-mcp-listing.ts`). A failure — even a throw —
 * affects only that agent's row.
 *
 *   connected      the entry points at the port libi serves on now
 *   stale-port     the entry exists but names another port, names no url, or
 *                  (Codex) is disabled — every case a Reconnect fixes
 *   not-connected  no entry — or no codex to ask
 *   unknown        the config could not be read / codex gave no listing (it
 *                  failed, timed out or printed something else) and there is
 *                  no earlier good one — never not-connected, which would
 *                  offer a Connect for an entry that may already exist
 *
 * When codex's current listing is still running or gave none but an earlier
 * one was good, Codex's state comes from that one, marked `stale` — the answer
 * provider detection gives for the same listing, so neither tab flips to
 * unknown while a good listing exists.
 */
export type LibiToolsState = "connected" | "stale-port" | "not-connected" | "unknown";
export interface LibiRegistration {
  state: LibiToolsState;
  /** Claude only: the scope the entry was found in — a `claude mcp remove` must name it. */
  scope?: "user" | "local";
  url?: string;
  /** Codex only: the state codex's last good listing gave, because the current listing is still running or gave none. */
  stale?: true;
}
export type LibiRegistrations = Record<SetupAgentId, LibiRegistration>;

/**
 * The file Claude Code keeps user-scope `mcpServers` in when CLAUDE_CONFIG_DIR is
 * set. Measured: `claude mcp add --scope user` under a temporary CLAUDE_CONFIG_DIR
 * writes `<CLAUDE_CONFIG_DIR>/.claude.json` and nothing else.
 */
export const CLAUDE_CONFIG_FILE_NAME = ".claude.json";

export function claudeConfigPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = os.homedir(),
): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, CLAUDE_CONFIG_FILE_NAME) : path.join(home, ".claude.json");
}

function portOf(url: string | undefined): number | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

function stateFor(url: string | undefined, currentPort: number): LibiToolsState {
  return portOf(url) === currentPort ? "connected" : "stale-port";
}

function urlOf(entry: object): string | undefined {
  const url = (entry as { url?: unknown }).url;
  return typeof url === "string" ? url : undefined;
}

function entryIn(servers: unknown): object | null {
  if (!servers || typeof servers !== "object") return null;
  const entry = (servers as Record<string, unknown>)[LIBI_MCP_ENTRY_NAME];
  return entry && typeof entry === "object" ? entry : null;
}

function found(entry: object, scope: "user" | "local", currentPort: number): LibiRegistration {
  const url = urlOf(entry);
  return { state: stateFor(url, currentPort), scope, ...(url ? { url } : {}) };
}

/** Pure. `cfg` is the parsed config file; anything but an object is "could not tell". */
export function libiRegistrationFromClaudeConfig(cfg: unknown, agentDir: string, currentPort: number): LibiRegistration {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return { state: "unknown" };
  const c = cfg as { mcpServers?: unknown; projects?: unknown };
  const user = entryIn(c.mcpServers);
  if (user) return found(user, "user", currentPort);
  const project =
    c.projects && typeof c.projects === "object" ? (c.projects as Record<string, unknown>)[agentDir] : undefined;
  const local = project && typeof project === "object" ? entryIn((project as { mcpServers?: unknown }).mcpServers) : null;
  if (local) return found(local, "local", currentPort);
  return { state: "not-connected" };
}

/**
 * Pure. `null` is what `mcpListJson` answers when codex could not be asked; any
 * other non-array is no information either → unknown. Items that are not
 * objects (`null`, a number, a string) are skipped, never matched.
 *
 * A `libi` entry codex will not load (`enabled: false`) is stale-port whatever
 * port it names: Reconnect re-creates it enabled. An entry with no string url
 * (a hand-written stdio entry, a null or malformed transport) is stale-port too,
 * with no url.
 */
export function libiRegistrationFromCodexList(entries: CodexMcpListEntry[] | null, currentPort: number): LibiRegistration {
  if (!Array.isArray(entries)) return { state: "unknown" };
  const e = entries.find((x) => x && typeof x === "object" && x.name === LIBI_MCP_ENTRY_NAME);
  if (!e) return { state: "not-connected" };
  const transport: unknown = e.transport;
  const rawUrl = transport && typeof transport === "object" ? (transport as { url?: unknown }).url : undefined;
  const url = typeof rawUrl === "string" ? rawUrl : undefined;
  const state: LibiToolsState = e.enabled === false ? "stale-port" : stateFor(url, currentPort);
  return { state, ...(url ? { url } : {}) };
}

/**
 * The command a resolved codex runs as — the shape `resolveAgentCli` ran its
 * `--version` through: the realPath as-is when native, through node when it is
 * a script, and a Windows npm `.cmd` shim as its JS target through node.
 * Spawning `path` or `execPath` directly instead fails for a CLI the resolver
 * proved working: a `.cmd` spawned without a shell is EINVAL, and a
 * `#!/usr/bin/env node` script needs `node` on this server's own PATH.
 */
export function codexSpawnShape(cli: { realPath: string }): ResolvedBin {
  return spawnViaNodeIfScript(cli.realPath);
}

export interface LibiRegistrationDeps {
  claudeConfigPath?: string;
  agentDir?: string;
  currentPort?: number;
  resolveCodex?: () => Promise<ResolvedAgentCli>;
  /**
   * Injected in tests: replaces the shared listing (`readCodexMcpListing`), handed the resolved codex's
   * `codexSpawnShape`. `null` reads as a listing codex gave no answer to.
   */
  codexList?: (cmd: ResolvedBin) => Promise<CodexMcpListEntry[] | null>;
  /** Default: read and parse the file (missing → an empty config, unreadable → null). */
  readClaudeConfig?: (file: string) => unknown;
  /** Detect ONE agent; the other reads `{ state: "not-connected" }` without any read or spawn. */
  only?: SetupAgentId;
  /** A Retry: skip the memo and ask codex again, joining a listing already running (`readCodexMcpListing`). */
  refresh?: boolean;
  /**
   * The wizard's Check again, not a plain Retry: a listing already running from before this call
   * is not trusted as this call's answer (the user may just have changed codex's config outside
   * libi) — it is let finish and exactly one more is asked. Meaningless without `refresh`, which
   * Check again always sets too. See `readCodexMcpListing`.
   */
  checkAgain?: boolean;
}

/**
 * Per-agent memo: a status poll every few seconds must not spawn codex on every tick. In-memory only. It keeps only
 * an answer read from a fresh listing: one served from codex's last good listing, or unknown because codex gave no
 * listing, is not kept, so the next poll picks up the running listing's answer as soon as it lands.
 */
const MEMO_MS = 5_000;
const memo = new Map<SetupAgentId, { at: number; value: LibiRegistration }>();
const inflight = new Map<SetupAgentId, Promise<LibiRegistration>>();
/** Bumped by a clear, so a read that started BEFORE it can never refill the memo after it. */
let generation = 0;

/**
 * Drop the memo — after anything that may have changed an agent's registration (a setup terminal exiting, "Check
 * again"), and in tests. It drops the shared codex listing too, whose last good listing would otherwise answer for
 * the config as it was before.
 */
export function __clearLibiRegistrationMemo(): void {
  generation++;
  memo.clear();
  inflight.clear();
  __clearCodexMcpListing();
}

function readClaudeConfig(file: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    // No file yet → nothing registered, not an error. Any OTHER read failure
    // (EACCES, EISDIR, …) means "we could not tell" → unknown.
    const code = (err as NodeJS.ErrnoException).code ?? null;
    if (code === "ENOENT") return { mcpServers: {} };
    logger.debug({ tag: "libi-registration", op: "claude_config_unreadable", code }, "could not read Claude's config");
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    logger.debug({ tag: "libi-registration", op: "claude_config_unparseable" }, "Claude's config is not valid JSON");
    return null;
  }
}

export async function detectLibiRegistration(deps: LibiRegistrationDeps = {}): Promise<LibiRegistrations> {
  // Injected deps mean a test or a one-off call — never serve or fill the memo.
  const memoable =
    !deps.claudeConfigPath &&
    !deps.agentDir &&
    deps.currentPort === undefined &&
    !deps.resolveCodex &&
    !deps.codexList &&
    !deps.readClaudeConfig;
  const one = async (id: SetupAgentId): Promise<LibiRegistration> => {
    if (!memoable) return (await detectOne(id, deps)).value;
    // A Retry neither takes the memo nor joins a detection that may already hold a memoised failure; its own
    // detection still joins a codex listing already running, so it never spawns a second one.
    if (!deps.refresh) {
      const hit = memo.get(id);
      if (hit && Date.now() - hit.at < MEMO_MS) return hit.value;
      const running = inflight.get(id);
      if (running) return running;
    }
    const gen = generation;
    const p = detectOne(id, deps)
      .then(({ value, keep }) => {
        if (keep && gen === generation) memo.set(id, { at: Date.now(), value });
        return value;
      })
      .finally(() => {
        if (inflight.get(id) === p) inflight.delete(id);
      });
    inflight.set(id, p);
    return p;
  };
  const skipped: LibiRegistration = { state: "not-connected" };
  const [claude, codex] = await Promise.all([
    deps.only === "codex" ? skipped : one("claude-code"),
    deps.only === "claude-code" ? skipped : one("codex"),
  ]);
  logger.debug(
    { tag: "libi-registration", op: "detect", claude: claude.state, codex: codex.state, only: deps.only ?? null },
    "libi registration detected",
  );
  return { "claude-code": claude, codex };
}

/** One agent's answer, and whether the memo may keep it (see the memo). */
interface Detected {
  value: LibiRegistration;
  keep: boolean;
}

/** One agent's detection. Anything that throws in it makes THAT agent's row unknown — never the other's. */
async function detectOne(id: SetupAgentId, deps: LibiRegistrationDeps): Promise<Detected> {
  try {
    return id === "claude-code" ? { value: detectClaude(deps), keep: true } : await detectCodex(deps);
  } catch (err) {
    logger.warn(
      { tag: "libi-registration", op: "detect_failed", agentId: id, code: (err as NodeJS.ErrnoException)?.code ?? null },
      "could not detect libi's registration for one agent",
    );
    return { value: { state: "unknown" }, keep: true };
  }
}

function detectClaude(deps: LibiRegistrationDeps): LibiRegistration {
  const currentPort = deps.currentPort ?? getRegistrationMcpPort();
  const agentDir = deps.agentDir ?? getLibiAgentDir();
  const read = deps.readClaudeConfig ?? readClaudeConfig;
  return libiRegistrationFromClaudeConfig(read(deps.claudeConfigPath ?? claudeConfigPath()), agentDir, currentPort);
}

async function detectCodex(deps: LibiRegistrationDeps): Promise<Detected> {
  const currentPort = deps.currentPort ?? getRegistrationMcpPort();
  const cli = await (deps.resolveCodex ?? (() => resolveAgentCli("codex")))();
  // Not found or broken → nothing to ask. Found but below the minimum is still
  // asked, exactly as Claude's file is still read (the row then says "update needed").
  if (cli === null || "foundButBroken" in cli) return { value: { state: "not-connected" }, keep: true };
  const cmd = codexSpawnShape(cli);
  const listing = await codexListing(cmd, deps);
  if (listing.state === "fresh") return { value: libiRegistrationFromCodexList(listing.entries, currentPort), keep: true };
  // No listing — failed, timed out or unparseable — is no information, never not-connected.
  if (listing.state === "unread" || listing.reason === "failed") {
    logger.warn(
      {
        tag: "libi-registration",
        op: "codex_list_no_answer",
        meetsMinimum: cli.meetsMinimum,
        viaNode: cmd.args.length > 0,
        hadListing: listing.state === "stale",
      },
      "codex mcp list --json gave no listing (failed, timed out, or printed something else)",
    );
  }
  if (listing.state === "unread") return { value: { state: "unknown" }, keep: false };
  // Still running after the wait, or failed since: codex's last good listing answers, marked stale, for both —
  // treating the two differently made the Global setup card flip between them while one slow listing ran.
  return { value: { ...libiRegistrationFromCodexList(listing.entries, currentPort), stale: true }, keep: false };
}

function codexListing(cmd: ResolvedBin, deps: LibiRegistrationDeps): Promise<CodexMcpListing> {
  if (!deps.codexList) return readCodexMcpListing(cmd, { refresh: deps.refresh, checkAgain: deps.checkAgain });
  return deps.codexList(cmd).then((entries): CodexMcpListing => (entries ? { state: "fresh", entries } : { state: "unread" }));
}

/** How old codex's last good listing may be and still describe the config a session starts with. */
export const LIBI_CODEX_ENTRY_SHAPE_MAX_AGE_MS = 60_000;

/**
 * The shape of the user's own `[mcp_servers.libi]` as codex reports it (`libiCodexEntryShape`), for the session-start
 * diagnostic in `lib/sessions/session-manager.ts`. It reads the listing provider detection and the registration check
 * share, never a spawn of its own: a memoised listing answers at once, a running one is joined, and otherwise the one
 * run every reader shares is started. When that run is slow or failed, codex's last good listing answers if it is at
 * most `LIBI_CODEX_ENTRY_SHAPE_MAX_AGE_MS` old.
 *
 * Its only bound is the shared read's own: `CODEX_MCP_LIST_WAIT_MS` with a last good listing, the 15 s spawn bound
 * without one. The caller does not await it, so session start never waits, and nothing here ends the run for another
 * reader. No usable codex, no listing, or only an older one is `unknown`.
 */
export async function readLibiCodexEntryShape(): Promise<LibiCodexEntryShape> {
  const cli = await resolveAgentCli("codex");
  if (cli === null || "foundButBroken" in cli) return "unknown";
  const listing = await readCodexMcpListing(codexSpawnShape(cli));
  if (listing.state === "fresh") return libiCodexEntryShape(listing.entries);
  if (listing.state === "stale" && Date.now() - listing.readAt <= LIBI_CODEX_ENTRY_SHAPE_MAX_AGE_MS) {
    return libiCodexEntryShape(listing.entries);
  }
  return "unknown";
}
