/**
 * Read-only detection of the MCP servers the user's agents already have.
 *
 * libi manages none of these and stores no key for any of them, so
 * this module NEVER writes and NEVER returns a value out of an `env` map or an
 * `Authorization` header — only whether one is present. The sources are the
 * agents' OWN files, never a list libi keeps:
 *
 *   Claude  `~/.claude.json` (or `<CLAUDE_CONFIG_DIR>/.claude.json`) top-level `mcpServers` (user scope) plus
 *           `projects[<libi agent dir>].mcpServers` (the local scope an in-app
 *           session runs under) plus `<agent dir>/.mcp.json`.
 *   Codex   `codex mcp list --json` through the user's own codex binary as
 *           `resolveAgentCli` resolved it — run the way it ran that binary's
 *           `--version` (`codexSpawnShape`) — against `resolveCodexHome()`.
 *
 * A provider the user signs in to with an account (catalog `auth: "oauth"`,
 * e.g. Higgsfield) has no key, so its HTTP entry is never `needs-key`. A local
 * (stdio) entry for one — an ElevenLabs `uvx elevenlabs-mcp` from before it
 * moved to its hosted server — runs on a key, and is read like a keyed entry.
 * Whether an HTTP entry is signed in is reported only where the agent itself
 * says so:
 *
 *   Codex   `auth_status` from the same `mcp list --json` call: `not_logged_in`
 *           → `needs-sign-in`. No extra spawn.
 *   Claude  `claude mcp get <name>`, on demand and never in the poll loop
 *           (`./claude-signin-probe.ts`). Claude keeps the OAuth tokens in its
 *           own secret store, which libi never reads, and `~/.claude.json` says
 *           nothing about them, so the CLI's own answer is the only one. It makes
 *           a live health-check round trip (~2-5 s) and writes
 *           `mcp-needs-auth-cache.json` into Claude's config folder: Claude's own
 *           cache, not its config, like the `mcp-oauth-locks/` codex makes while
 *           listing — but one that hides the server from Claude's chats if a
 *           probe overlaps its `mcp login`, so none ever does (the probe module's
 *           header). One probe per entry runs when detection first sees an entry
 *           with no answer, and again when its answer expires, a setup terminal
 *           goes away, its sign-in ends, or the user looks with an answer that is
 *           not "signed in" (`revalidateClaude`); the last answer is served
 *           meanwhile. Only the `Status:` line is read: Connected → the row stays
 *           `connected`; Needs authentication → `needs-sign-in`. Until the first
 *           answer the row is `connected` with `signIn: "unknown"` and
 *           `signInCheck: "pending"`; a status it can't read, a failure or a
 *           timeout leaves `signIn: "unknown"`, which the Providers tab shows as
 *           "Added · sign in to use" with Sign in and Remove.
 *
 * The Codex listing is itself a network call. For every HTTP entry with no
 * bearer token and no stored sign-in, `codex mcp list --json` runs OAuth
 * discovery against the server to fill `auth_status`. Measured on codex-cli
 * 0.153.4 with a scratch CODEX_HOME:
 *
 *   - a local server logged 8 GETs per such entry: `/mcp`, then the
 *     oauth-protected-resource, oauth-authorization-server and
 *     openid-configuration `.well-known` paths. A stdio entry and a
 *     `bearer_token_env_var` entry made none (0.03-0.04 s wall);
 *   - a Higgsfield entry took 1.0-2.6 s online, and 0.04 s reading `unknown`
 *     with outbound network denied (sandbox-exec);
 *   - a server that never answers took 5.05 s and read `unknown`: codex's own
 *     discovery bound. Three such entries took 5.06 s, so codex probes them in
 *     parallel and the bound does not grow with the entry count;
 *   - listing an HTTP entry also creates `mcp-oauth-locks/` in CODEX_HOME
 *     (codex's own state, not its config).
 *
 * So the listing is shared with libi's own registration check, with one bound
 * well above that ~5 s, one run at a time and one memo
 * (`lib/agents/codex-mcp-listing.ts`). At the 5 s libi used before, one silent
 * provider got the whole list killed, where codex would have read that one
 * entry as `unknown`.
 *
 * A listing that fails, times out or prints something else is no information,
 * never "no entries". Detection then serves codex's last good rows, each marked
 * `stale`, with `codex: "stale"`. With no last good listing it serves no Codex
 * rows and `codex: "unread"`. The same stale answer comes back when a caller
 * that has a last good listing has waited out a listing that is still running.
 * The Providers tab shows either state as such, never as "Not added".
 *
 * A local (stdio) entry whose launch command can't be found on this computer —
 * Claude's `command`, or Codex's `transport.command` — reads `cant-start`, with
 * `missingCommand` naming the bare command (`./launcher.ts` decides, without
 * spawning anything). It beats `needs-key` and a sign-in state, since a server
 * that can't start is the first thing to fix; a `disabled` Codex entry stays
 * `disabled`. A lookup that can't decide (no login-shell PATH known yet) leaves
 * the row as it was: unknown is not broken.
 *
 * A launcher found on the login-shell PATH may have been installed after libi
 * started an agent. A new agent process, and a new Claude Code chat, get the
 * login-shell PATH (`lib/agents/agent-path.ts`), but a running Codex process
 * keeps the PATH it started with, and so do the MCP servers it starts. A Codex
 * row whose launcher is on none of that process's folders reads
 * `launcherAfterStart`, and the tab says to restart libi rather than that it is
 * ready.
 */
import fs from "node:fs";
import path from "node:path";
import { serverLogger as logger } from "@/lib/logger";
import { getLibiAgentDir } from "@/lib/libi-home";
import type { CodexMcpListEntry } from "@/lib/codex-config/codex-cli";
import { isUsableCli, resolveAgentCli, type ResolvedAgentCli } from "@/lib/agents/cli/resolve";
import type { ResolvedBin } from "@/lib/agents/cli/spawn-shape";
import { claudeConfigPath, codexSpawnShape } from "@/lib/agents/libi-registration";
import { __clearCodexMcpListing, readCodexMcpListing, type CodexMcpListing } from "@/lib/agents/codex-mcp-listing";
import { findProvider, matchProvider, type ProviderId } from "./catalog";
import { launcherLookupForPass, launcherName, lookupLauncher, type LauncherDeps } from "./launcher";
import { agentSpawnPathDirs } from "@/lib/agents/agent-path";
import {
  __clearClaudeSignInMemo,
  lookupClaudeSignIn,
  retainClaudeSignIn,
  type ClaudeSignInEntry,
  type ClaudeSignInLookup,
} from "./claude-signin-probe";

export interface DetectedMcp {
  agent: "claude" | "codex";
  name: string;
  providerId: ProviderId | null;
  transport: "http" | "stdio";
  status: "connected" | "needs-key" | "needs-sign-in" | "disabled" | "cant-start";
  /**
   * `cant-start` rows only: the launch command that can't be found, as its bare
   * name (`uvx`) — never a folder, an argument or an env value.
   */
  missingCommand?: string;
  /**
   * Only on a row for a provider the user signs in to with an account (catalog
   * `auth: "oauth"`) whose sign-in libi cannot see: a Claude row without an
   * Authorization header that `claude mcp get` has not answered (yet), and a
   * Codex row whose `auth_status` says neither signed in nor signed out. Never
   * set when the answer is known.
   */
  signIn?: "unknown";
  /**
   * Claude rows with `signIn: "unknown"` only: libi is asking Claude Code right now whether it has signed in
   * (`./claude-signin-probe.ts`), so asking again shortly gets the answer.
   */
  signInCheck?: "pending";
  /** Claude rows only — the config scope the entry was read from, which is the
   *  `--scope` a `claude mcp remove` must name (the CLI refuses a name that
   *  lives in another scope; `local`/`project` resolve by cwd). Codex has no
   *  scopes, so its rows omit the key. */
  scope?: "user" | "local" | "project";
  /** Codex rows only, and only when codex gave no fresh listing: the row is from its last good one. */
  stale?: true;
  /**
   * Codex stdio rows only: the launcher was found, but on none of the folders of the PATH Codex's running
   * process in libi started with — it was installed since — so Codex's chats in libi can't start this server
   * until that process is replaced (restarting libi). See the header.
   */
  launcherAfterStart?: true;
}

/** What detection answers. */
export interface ProviderDetection {
  connected: DetectedMcp[];
  /**
   * Absent when Codex's rows are a fresh answer (or there is no codex to ask).
   * `stale`: they are codex's last good listing, each row marked `stale`.
   * `unread`: codex gave no listing and there is no earlier one, so there are no
   * Codex rows — which is NOT "no entries".
   */
  codex?: "stale" | "unread";
}

export type CodexExecResult = { ok: true; stdout: string } | { ok: false; stderr: string };

export interface DetectDeps {
  /** Default `claudeConfigPath()` — `~/.claude.json`, honouring CLAUDE_CONFIG_DIR. */
  claudeConfigPath?: string;
  /** Default `getLibiAgentDir()` — the project key an in-app Claude session runs under. */
  agentDir?: string;
  /** Injected in tests: replaces BOTH the resolve and the list. Default: `codex mcp list --json`
   *  through the codex `resolveAgentCli` resolved. */
  codexExec?: (args: string[]) => Promise<CodexExecResult>;
  /** Injected in tests. Default: `resolveAgentCli("codex")`. */
  resolveCodex?: () => Promise<ResolvedAgentCli>;
  /** Injected in tests: replaces the shared listing (`readCodexMcpListing`), handed the resolved codex's
   *  `codexSpawnShape`. `null` reads as a listing codex gave no answer to. */
  codexList?: (cmd: ResolvedBin) => Promise<CodexMcpListEntry[] | null>;
  now?: () => number;
  /** A Retry: skip the memo and ask codex again, joining a listing already running (`readCodexMcpListing`). */
  refresh?: boolean;
  /** Injected in tests: the folders and file check the launcher lookup uses (`./launcher.ts`). */
  launcher?: LauncherDeps;
  /** Injected in tests: the PATH folders an agent's running process started with, null when none runs. Default `agentSpawnPathDirs`. */
  agentPathDirs?: (agent: "claude" | "codex") => string[] | null;
  /**
   * Answers whether Claude Code has signed in to an entry (`lookupClaudeSignIn`). Default: that lookup — except
   * when a test injects the config or codex deps above, where nothing is probed and the answer stays unknown.
   */
  claudeSignIn?: (entry: ClaudeSignInEntry, opts: { revalidate: boolean }) => ClaudeSignInLookup;
  /** The user just looked or pressed Retry: an answer that is not "signed in" and is not recent is asked again. */
  revalidateClaude?: boolean;
}

/**
 * `auth_status` as `codex mcp list --json` prints it. codex's McpAuthStatus has
 * five variants — Unknown, Unsupported, NotLoggedIn, BearerToken, OAuth
 * (`codex app-server generate-ts` on codex-cli 0.153.4 lists the same five) —
 * and the CLI prints them in snake_case: against a scratch CODEX_HOME it printed
 * `not_logged_in` for a fresh Higgsfield entry, `bearer_token` for
 * `--bearer-token-env-var`, and `unsupported` for stdio. NotLoggedIn also covers
 * stored tokens that need signing in again (codex's rmcp-client maps both
 * logged-out cases to it). OAuth prints as `o_auth`: seen against a scratch
 * CODEX_HOME holding a stored file-store credential (`mcp_oauth_credentials_store
 * = "file"`), no real sign-in involved. `oauth` is still accepted. Anything else —
 * `unknown`, `unsupported` on an HTTP entry, or no field — is not an answer.
 */
const CODEX_NOT_LOGGED_IN = "not_logged_in";
const CODEX_SIGNED_IN = new Set(["o_auth", "oauth", "bearer_token"]);

function isOAuthProvider(providerId: ProviderId | null): boolean {
  return providerId !== null && findProvider(providerId).auth === "oauth";
}

/** libi's own endpoints — never shown as a provider. */
const LIBI_NAMES = new Set(["libi", "libi-app"]);


interface ClaudeEntry {
  type?: string;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function claudeRow(name: string, entry: ClaudeEntry, scope: NonNullable<DetectedMcp["scope"]>): DetectedMcp {
  const isHttp = entry.type === "http" || entry.type === "sse" || (!entry.command && !!entry.url);
  // "Has a key" means a non-empty Authorization header (http) or at least one
  // non-empty env entry (stdio). PRESENCE only — the value is never read out.
  const hasKey = isHttp
    ? Object.entries(entry.headers ?? {}).some(
        ([k, v]) => k.toLowerCase() === "authorization" && typeof v === "string" && v.trim().length > 0,
      )
    : Object.values(entry.env ?? {}).some((v) => typeof v === "string" && v.length > 0);
  const providerId = matchProvider(name, entry.url);
  const row: DetectedMcp = { agent: "claude", name, providerId, transport: isHttp ? "http" : "stdio", status: "connected", scope };
  // An account sign-in is never a missing key. Claude keeps it outside its
  // config, so it is unknown here unless the entry carries its own
  // Authorization header; Claude Code's own answer goes over it later
  // (`withClaudeSignIn`, see the header). Only an HTTP entry signs in: a local
  // one (an older `uvx elevenlabs-mcp`) runs on a key.
  if (isOAuthProvider(providerId) && isHttp) return !hasKey ? { ...row, signIn: "unknown" } : row;
  // Only a CATALOG provider can be "needs-key": libi has no idea whether a
  // server it has never heard of wants one.
  return providerId && !hasKey ? { ...row, status: "needs-key" } : row;
}

/** Checks one stdio row's launch command; see the header. */
type LauncherCheck = (row: DetectedMcp, command: unknown) => DetectedMcp;

/**
 * The launcher state last logged per `<agent>:<name>`, so a row polled every few
 * seconds logs once when its launcher goes missing and once when it is found
 * again. `unknown` changes nothing here. In memory only. The entry's name goes
 * out as `entry`: `name` is the logger's own field ("server"), and a second one
 * would be a duplicate JSON key.
 */
const launcherLogged = new Map<string, "found" | "missing">();

/** Tests only. */
export function __resetLauncherStatusLog(): void {
  launcherLogged.clear();
}

function launcherCheck(deps: LauncherDeps | undefined, agentPathDirs: NonNullable<DetectDeps["agentPathDirs"]>): LauncherCheck {
  const platform = deps?.platform ?? process.platform;
  const lookup = launcherLookupForPass(deps);
  /** Whether a running Codex process's own PATH has the launcher; true when no Codex process runs (the next gets it). */
  const codexProcessSees = (command: string): boolean => {
    const dirs = agentPathDirs("codex");
    if (dirs === null) return true;
    return lookupLauncher(command, { ...deps, loginShellDirs: () => [], processPathDirs: () => dirs }) !== "missing";
  };
  return (row, command) => {
    if (row.transport !== "stdio" || row.status === "disabled" || typeof command !== "string") return row;
    const found = lookup(command);
    if (found === "unknown") return row;
    const name = launcherName(command, platform);
    const key = `${row.agent}:${row.name}`;
    const before = launcherLogged.get(key);
    if (found === "missing" && before !== "missing") {
      logger.info({ tag: "providers", op: "launcher_missing", agent: row.agent, entry: row.name, command: name }, "a local MCP server's launcher can't be found");
    } else if (found === "found" && before === "missing") {
      logger.info({ tag: "providers", op: "launcher_found", agent: row.agent, entry: row.name, command: name }, "a local MCP server's launcher is back");
    }
    launcherLogged.set(key, found);
    if (found === "found") return row.agent === "codex" && !codexProcessSees(command) ? { ...row, launcherAfterStart: true } : row;
    // A server that can't start has no sign-in to speak of either.
    const next: DetectedMcp = { ...row, status: "cant-start", missingCommand: name };
    delete next.signIn;
    return next;
  };
}

/**
 * Claude's rows, and the entries among them whose sign-in only Claude Code can answer: a row with
 * `signIn: "unknown"` and a url, which `claude mcp get` is asked about (see the header).
 */
function detectClaude(
  configPath: string,
  agentDir: string,
  check: LauncherCheck,
): { rows: DetectedMcp[]; signInTargets: ClaudeSignInEntry[]; configRead: boolean } {
  const out = new Map<string, DetectedMcp>();
  const signInTargets: ClaudeSignInEntry[] = [];
  const addAll = (servers: unknown, scope: NonNullable<DetectedMcp["scope"]>) => {
    if (!servers || typeof servers !== "object") return;
    for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
      if (LIBI_NAMES.has(name)) continue;
      if (!entry || typeof entry !== "object") continue;
      if (out.has(name)) continue; // user scope wins; first writer keeps the slot
      const row = check(claudeRow(name, entry as ClaudeEntry, scope), (entry as ClaudeEntry).command);
      out.set(name, row);
      const url = (entry as ClaudeEntry).url;
      if (row.signIn === "unknown" && typeof url === "string" && url.length > 0) signInTargets.push({ name, url });
    }
  };

  const cfg = readJson(configPath);
  if (cfg) {
    addAll(cfg.mcpServers, "user");
    const projects = cfg.projects;
    if (projects && typeof projects === "object") {
      const scoped = (projects as Record<string, unknown>)[agentDir];
      if (scoped && typeof scoped === "object") addAll((scoped as { mcpServers?: unknown }).mcpServers, "local");
    }
  }

  addAll(readJson(path.join(agentDir, ".mcp.json"))?.mcpServers, "project");
  return { rows: [...out.values()], signInTargets, configRead: cfg !== null };
}

/**
 * Claude's own answer, where it has one, over each row whose sign-in libi can't see from the config. Applied to
 * every answer, memoised or not, so a probe that lands shows on the next poll; never mutates the memo's rows.
 */
function withClaudeSignIn(
  base: DetectedBase,
  lookup: NonNullable<DetectDeps["claudeSignIn"]>,
  revalidate: boolean,
): ProviderDetection {
  if (base.signInTargets.length === 0) return base.value;
  const urls = new Map(base.signInTargets.map((t) => [t.name, t.url]));
  const connected = base.value.connected.map((row): DetectedMcp => {
    const url = row.agent === "claude" && row.signIn === "unknown" ? urls.get(row.name) : undefined;
    if (url === undefined) return row;
    const answer = lookup({ name: row.name, url }, { revalidate });
    const known: DetectedMcp = { ...row };
    delete known.signIn;
    switch (answer) {
      case "signed-in":
        return known;
      case "needs-sign-in":
        return { ...known, status: "needs-sign-in" };
      case "pending":
        return { ...row, signInCheck: "pending" };
      default:
        return row;
    }
  });
  return { ...base.value, connected };
}

const noClaudeSignIn: NonNullable<DetectDeps["claudeSignIn"]> = () => "unknown";

function parseCodexListing(stdout: string): CodexMcpListEntry[] | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed) ? (parsed as CodexMcpListEntry[]) : null;
  } catch {
    return null;
  }
}

async function detectCodex(deps: DetectDeps, check: LauncherCheck): Promise<{ rows: DetectedMcp[]; codex?: "stale" | "unread" }> {
  let listing: CodexMcpListing;
  if (deps.codexExec) {
    const res = await deps.codexExec(["mcp", "list", "--json"]);
    const entries = res.ok ? parseCodexListing(res.stdout) : null;
    listing = entries ? { state: "fresh", entries } : { state: "unread" };
  } else {
    const cli = await (deps.resolveCodex ?? (() => resolveAgentCli("codex")))();
    // "Not available" is a normal answer, not a failure: many users have no
    // codex at all. It contributes no rows and never blocks the Claude half.
    if (!isUsableCli(cli)) return { rows: [] };
    const cmd = codexSpawnShape(cli);
    if (deps.codexList) {
      const entries = await deps.codexList(cmd);
      listing = entries ? { state: "fresh", entries } : { state: "unread" };
    } else {
      listing = await readCodexMcpListing(cmd, { refresh: deps.refresh });
    }
  }
  if (listing.state === "unread") {
    logger.warn({ tag: "providers", op: "codex_list_unread" }, "codex gave no MCP listing and there is no earlier one to show");
    return { rows: [], codex: "unread" };
  }
  const rows = codexRows(listing.entries, check);
  if (listing.state === "fresh") return { rows };
  return { rows: rows.map((row) => ({ ...row, stale: true as const })), codex: "stale" };
}

function codexRows(entries: CodexMcpListEntry[], check: LauncherCheck): DetectedMcp[] {
  const out: DetectedMcp[] = [];
  for (const e of entries) {
    if (!e || typeof e !== "object" || typeof e.name !== "string" || LIBI_NAMES.has(e.name)) continue;
    const isHttp = e.transport?.type !== "stdio";
    const providerId = matchProvider(e.name, e.transport?.url);
    // Codex never inlines an HTTP bearer token — it is an env-var NAME. For
    // stdio, `env` (inlined) or `env_vars` (forwarded) both count as "has one".
    const hasKey = isHttp
      ? typeof e.transport?.bearer_token_env_var === "string" && e.transport.bearer_token_env_var.length > 0
      : Object.keys(e.transport?.env ?? {}).length > 0 || (e.transport?.env_vars?.length ?? 0) > 0;
    const row: DetectedMcp = { agent: "codex", name: e.name, providerId, transport: isHttp ? "http" : "stdio", status: "connected" };
    const push = (r: DetectedMcp) => out.push(check(r, e.transport?.command));
    if (e.enabled === false) {
      push({ ...row, status: "disabled" });
    } else if (isOAuthProvider(providerId) && isHttp) {
      // An account sign-in is never a missing key; codex says whether it has one. A local entry runs on a key.
      if (CODEX_SIGNED_IN.has(String(e.auth_status))) push(row);
      else if (e.auth_status === CODEX_NOT_LOGGED_IN) push({ ...row, status: "needs-sign-in" });
      else push({ ...row, signIn: "unknown" });
    } else {
      push(providerId && !hasKey ? { ...row, status: "needs-key" } : row);
    }
  }
  return out;
}

/** What one detection read, before Claude's sign-in answers go over it (`withClaudeSignIn`). */
interface DetectedBase {
  value: ProviderDetection;
  signInTargets: ClaudeSignInEntry[];
  /** `~/.claude.json` was read and parsed: `signInTargets` is the whole list, not what a failed read left. */
  claudeConfigRead: boolean;
}

/** 5 s memo so the settings poll and the panel poll do not each re-read.
 *  In-memory only — nothing survives a boot. It keeps only an answer with fresh
 *  Codex rows: a stale or unread one is not kept, so the next poll picks up the
 *  running listing's answer as soon as it lands. */
const MEMO_MS = 5_000;
let memo: { at: number; value: DetectedBase } | null = null;
/** The detection running now, shared by every caller that arrives before it ends. */
let inflight: Promise<DetectedBase> | null = null;
/** Bumped by a clear, so a detection that started BEFORE it never fills the memo after it. */
let generation = 0;

/** Drop the memo and forget a running detection. Called when a setup terminal
 *  goes away (a provider `mcp add` / `mcp remove` / `mcp login` may have run in
 *  it) so the next poll re-reads, and by tests. It drops the shared codex listing
 *  too, whose last good listing would otherwise answer for the config as it was
 *  before, and Claude Code's sign-in answers, which a sign-in there may have
 *  changed. */
export function __clearProviderMemo(): void {
  generation++;
  memo = null;
  inflight = null;
  __clearCodexMcpListing();
  __clearClaudeSignInMemo();
}

export async function detectProviders(deps: DetectDeps = {}): Promise<ProviderDetection> {
  const now = deps.now ?? Date.now;
  // Injected deps mean a test or a one-off call — never serve or fill the memo, nor share a running detection.
  const memoable =
    !deps.claudeConfigPath && !deps.agentDir && !deps.codexExec && !deps.resolveCodex && !deps.codexList && !deps.launcher && !deps.agentPathDirs;
  const signIn = deps.claudeSignIn ?? (memoable ? lookupClaudeSignIn : noClaudeSignIn);
  const base = await detectBase(deps, memoable, now);
  // Answers for entries no longer in the config go: a removed and re-added entry is asked afresh. Only after a
  // read that worked: Claude rewrites `~/.claude.json` all the time, and a read caught mid-write lists nothing.
  if (!deps.claudeSignIn && memoable && base.claudeConfigRead) retainClaudeSignIn(base.signInTargets);
  return withClaudeSignIn(base, signIn, deps.revalidateClaude === true);
}

async function detectBase(deps: DetectDeps, memoable: boolean, now: () => number): Promise<DetectedBase> {
  if (!memoable) return detectOnce(deps);
  // A Retry neither takes the memo nor joins a detection that may already hold a memoised failure; its own
  // detection still joins a codex listing already running, so it never spawns a second one.
  if (!deps.refresh) {
    if (memo && now() - memo.at < MEMO_MS) return memo.value;
    if (inflight) return inflight;
  }

  const started = generation;
  const run = detectOnce(deps)
    .then((value) => {
      if (started === generation && !value.value.codex) memo = { at: now(), value };
      return value;
    })
    .finally(() => {
      if (inflight === run) inflight = null;
    });
  inflight = run;
  return run;
}

async function detectOnce(deps: DetectDeps): Promise<DetectedBase> {
  const configPath = deps.claudeConfigPath ?? claudeConfigPath();
  const agentDir = deps.agentDir ?? getLibiAgentDir();

  const check = launcherCheck(deps.launcher, deps.agentPathDirs ?? ((agent) => agentSpawnPathDirs(agent === "claude" ? "claude-code" : agent)));
  // Codex first: resolving codex may run the login-shell probe, whose PATH the launcher lookup then reads.
  const codex = await detectCodex(deps, check);
  const { rows: claude, signInTargets, configRead } = detectClaude(configPath, agentDir, check);
  const connected = [...claude, ...codex.rows];

  logger.debug(
    {
      tag: "providers",
      op: "detect",
      claude: claude.length,
      codex: codex.rows.length,
      codexListing: codex.codex ?? "fresh",
      names: connected.map((v) => `${v.agent}:${v.name}`),
    },
    "detected provider MCPs",
  );
  return { value: codex.codex ? { connected, codex: codex.codex } : { connected }, signInTargets, claudeConfigRead: configRead };
}
