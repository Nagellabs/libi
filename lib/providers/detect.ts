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
 * e.g. Higgsfield) has no key, so it is never `needs-key`. Whether it is signed
 * in is reported only where the agent itself says so:
 *
 *   Codex   `auth_status` from the same `mcp list --json` call: `not_logged_in`
 *           → `needs-sign-in`. No extra spawn.
 *   Claude  never probed. The only thing that answers is `claude mcp get <name>`,
 *           and checked on claude 2.1.245 it (a) makes a live health-check round
 *           trip to the provider (~2.2 s wall for Higgsfield), (b) prints a
 *           human-readable status, not JSON, and (c) WRITES
 *           `mcp-needs-auth-cache.json` into Claude's config folder on every
 *           run. A detector that polls every few seconds while a setup terminal
 *           is open must not make a server-spawned CLI write into the agent's
 *           config folder, nor parse display text. Claude keeps the OAuth tokens
 *           outside `~/.claude.json`, so the config says nothing either. The row
 *           reads `connected` with `signIn: "unknown"`, which the Providers tab
 *           shows as "Added · sign in to use" with Sign in and Remove.
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
import { PROVIDER_CATALOG, findProvider, type ProviderId } from "./catalog";

export interface DetectedMcp {
  agent: "claude" | "codex";
  name: string;
  providerId: ProviderId | null;
  transport: "http" | "stdio";
  status: "connected" | "needs-key" | "needs-sign-in" | "disabled";
  /**
   * Only on a row for a provider the user signs in to with an account (catalog
   * `auth: "oauth"`) whose sign-in libi cannot see: every such Claude row without
   * an Authorization header, and a Codex row whose `auth_status` says neither
   * signed in nor signed out. Never set when the answer is known.
   */
  signIn?: "unknown";
  /** Claude rows only — the config scope the entry was read from, which is the
   *  `--scope` a `claude mcp remove` must name (the CLI refuses a name that
   *  lives in another scope; `local`/`project` resolve by cwd). Codex has no
   *  scopes, so its rows omit the key. */
  scope?: "user" | "local" | "project";
  /** Codex rows only, and only when codex gave no fresh listing: the row is from its last good one. */
  stale?: true;
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

/** Match an agent's server name / url against the catalog. */
function providerIdFor(name: string, url: string | undefined): ProviderId | null {
  const lower = name.toLowerCase();
  let host = "";
  if (url) {
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      host = "";
    }
  }
  for (const def of PROVIDER_CATALOG) {
    if (def.match.names.some((n) => n.toLowerCase() === lower)) return def.id;
    if (host && def.match.urls?.some((u) => host === u || host.endsWith(`.${u}`))) return def.id;
  }
  return null;
}

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
  const providerId = providerIdFor(name, entry.url);
  const row: DetectedMcp = { agent: "claude", name, providerId, transport: isHttp ? "http" : "stdio", status: "connected", scope };
  // An account sign-in is never a missing key. Claude keeps it outside its
  // config and libi does not probe for it (see the header), so it is unknown
  // unless the entry carries its own Authorization header.
  if (isOAuthProvider(providerId)) return isHttp && !hasKey ? { ...row, signIn: "unknown" } : row;
  // Only a CATALOG provider can be "needs-key": libi has no idea whether a
  // server it has never heard of wants one.
  return providerId && !hasKey ? { ...row, status: "needs-key" } : row;
}

function detectClaude(configPath: string, agentDir: string): DetectedMcp[] {
  const out = new Map<string, DetectedMcp>();
  const addAll = (servers: unknown, scope: NonNullable<DetectedMcp["scope"]>) => {
    if (!servers || typeof servers !== "object") return;
    for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
      if (LIBI_NAMES.has(name)) continue;
      if (!entry || typeof entry !== "object") continue;
      if (out.has(name)) continue; // user scope wins; first writer keeps the slot
      out.set(name, claudeRow(name, entry as ClaudeEntry, scope));
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
  return [...out.values()];
}

function parseCodexListing(stdout: string): CodexMcpListEntry[] | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed) ? (parsed as CodexMcpListEntry[]) : null;
  } catch {
    return null;
  }
}

async function detectCodex(deps: DetectDeps): Promise<{ rows: DetectedMcp[]; codex?: "stale" | "unread" }> {
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
  const rows = codexRows(listing.entries);
  if (listing.state === "fresh") return { rows };
  return { rows: rows.map((row) => ({ ...row, stale: true as const })), codex: "stale" };
}

function codexRows(entries: CodexMcpListEntry[]): DetectedMcp[] {
  const out: DetectedMcp[] = [];
  for (const e of entries) {
    if (!e || typeof e !== "object" || typeof e.name !== "string" || LIBI_NAMES.has(e.name)) continue;
    const isHttp = e.transport?.type !== "stdio";
    const providerId = providerIdFor(e.name, e.transport?.url);
    // Codex never inlines an HTTP bearer token — it is an env-var NAME. For
    // stdio, `env` (inlined) or `env_vars` (forwarded) both count as "has one".
    const hasKey = isHttp
      ? typeof e.transport?.bearer_token_env_var === "string" && e.transport.bearer_token_env_var.length > 0
      : Object.keys(e.transport?.env ?? {}).length > 0 || (e.transport?.env_vars?.length ?? 0) > 0;
    const row: DetectedMcp = { agent: "codex", name: e.name, providerId, transport: isHttp ? "http" : "stdio", status: "connected" };
    if (e.enabled === false) {
      out.push({ ...row, status: "disabled" });
    } else if (isOAuthProvider(providerId)) {
      // An account sign-in is never a missing key; codex says whether it has one.
      if (!isHttp || CODEX_SIGNED_IN.has(String(e.auth_status))) out.push(row);
      else if (e.auth_status === CODEX_NOT_LOGGED_IN) out.push({ ...row, status: "needs-sign-in" });
      else out.push({ ...row, signIn: "unknown" });
    } else {
      out.push(providerId && !hasKey ? { ...row, status: "needs-key" } : row);
    }
  }
  return out;
}

/** 5 s memo so the settings poll and the panel poll do not each re-read.
 *  In-memory only — nothing survives a boot. It keeps only an answer with fresh
 *  Codex rows: a stale or unread one is not kept, so the next poll picks up the
 *  running listing's answer as soon as it lands. */
const MEMO_MS = 5_000;
let memo: { at: number; value: ProviderDetection } | null = null;
/** The detection running now, shared by every caller that arrives before it ends. */
let inflight: Promise<ProviderDetection> | null = null;
/** Bumped by a clear, so a detection that started BEFORE it never fills the memo after it. */
let generation = 0;

/** Drop the memo and forget a running detection. Called when a setup terminal
 *  goes away (a provider `mcp add` / `mcp remove` may have run in it) so the next
 *  poll re-reads, and by tests. It drops the shared codex listing too, whose last
 *  good listing would otherwise answer for the config as it was before. */
export function __clearProviderMemo(): void {
  generation++;
  memo = null;
  inflight = null;
  __clearCodexMcpListing();
}

export async function detectProviders(deps: DetectDeps = {}): Promise<ProviderDetection> {
  const now = deps.now ?? Date.now;
  // Injected deps mean a test or a one-off call — never serve or fill the memo, nor share a running detection.
  const memoable = !deps.claudeConfigPath && !deps.agentDir && !deps.codexExec && !deps.resolveCodex && !deps.codexList;
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
      if (started === generation && !value.codex) memo = { at: now(), value };
      return value;
    })
    .finally(() => {
      if (inflight === run) inflight = null;
    });
  inflight = run;
  return run;
}

async function detectOnce(deps: DetectDeps): Promise<ProviderDetection> {
  const configPath = deps.claudeConfigPath ?? claudeConfigPath();
  const agentDir = deps.agentDir ?? getLibiAgentDir();

  const claude = detectClaude(configPath, agentDir);
  const codex = await detectCodex(deps);
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
  return codex.codex ? { connected, codex: codex.codex } : { connected };
}
