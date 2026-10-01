/**
 * Agent surface gating — restricts an MCP tool to the runtime "surface" the
 * calling agent runs on.
 *
 *  - **in-app** — the ACP chat. Can render rich UI (inline media cards).
 *  - **cli**    — a terminal agent (the user's own Claude Code / Codex).
 *
 * The surface is carried as the `x-libi-surface` HTTP header on the MCP
 * request. libi's own ACP entry sets it (`lib/mcp-config.ts#getMcpServersForAcp`);
 * nothing an external CLI registers does, so a terminal agent reports `cli` and
 * in-app-only tools are never registered for it. The stdio entry
 * (`libi serve-mcp`) has no headers and is always `cli`.
 *
 * NOT A TRUST BOUNDARY. The header is a HINT that selects which tools get
 * registered, nothing more: any client can send it, and one that does simply
 * gets `libi.show_in_chat` — a tool that asks the studio UI to display a piece
 * the caller could already read. There is no authorization decision here, so
 * do not put one behind this: a genuinely privileged tool needs its own check,
 * not an in-app registration.
 *
 * To gate a NEW tool to the in-app chat: in `createLibiMcpServer`, wrap its
 * `registerTool` in `if (opts.surface === "in-app")`.
 */
export type AgentSurface = "in-app" | "cli";

export const SURFACE_HEADER = "x-libi-surface";
export const IN_APP_SURFACE: AgentSurface = "in-app";
export const CLI_SURFACE: AgentSurface = "cli";

/**
 * The ONE name libi's MCP endpoint is registered under, on every surface:
 * what `libi connect` writes into the user's own agent config
 * (`lib/cli/connect.ts#MCP_SERVER_NAME`) AND what the in-app ACP entry is
 * called (`lib/mcp-config.ts#getMcpServersForAcp`).
 *
 * **The collision is the mechanism, not an accident.** libi cannot un-register
 * what the user's config holds — it never writes that file — so the only way an
 * in-app session mounts libi ONCE is for libi's own ACP entry to REPLACE the
 * config entry, which both adapters do by name:
 *
 *  - **Claude** — the ACP adapter hands the SDK `mcpServers`, which reaches the
 *    CLI as `--mcp-config`; a name there wins over the same name in config.
 *    Measured 2026-09-09 on Claude Code 2.1.245 against a header-echoing
 *    server: entry named `libi-app` → 8 requests (4 headerless + 4 in-app, two
 *    sessions); named `libi` → 4 requests, ALL carrying `x-libi-surface:
 *    in-app`. A second, unrelated config MCP connected in both runs.
 *  - **Codex** — the ACP entry becomes a `thread/start` config override, which
 *    codex deep-merges per server name over the config layers. Measured the
 *    same day driving `codex app-server` (codex-cli 0.153.4) directly: named
 *    `libi-app` → three servers start (`libi`, `libi-app`, the user's);
 *    named `libi` → two (`libi` with the in-app header, and the user's).
 *
 * That is why the entry is NOT called `libi-app` any more. The rename shipped
 * because codex-acp DROPS an ACP entry whose name is already in config
 * (`shouldDeduplicateMcpConflicts`, disabled by `CODEX_ACP_DISABLE_MCP_FILTER_ENV`
 * below) — it fixed the dropped header, but it also stopped the two entries
 * deduplicating, so a `libi connect`-ed machine mounted libi twice and carried
 * ~194 duplicated tool schemas in every in-app context.
 *
 * Change this name and BOTH halves move together, which is the point; a name
 * that differs from what `libi connect` already wrote on existing machines
 * re-creates the twin, and no migration can fix that retroactively.
 *
 * KNOWN EDGE, Codex only. Codex merges the override into the config entry
 * FIELD BY FIELD, so anything else the user put in their own
 * `[mcp_servers.libi]` survives alongside libi's url + header (measured on
 * codex-cli 0.153.4):
 *
 *  - `enabled = false` survives → an in-app session gets NO libi at all.
 *  - a STDIO entry (`command = …`) survives → the merged table has both
 *    `command` and `url`, and codex rejects the whole config:
 *    `thread/start` answers `failed to load configuration: url is not
 *    supported for stdio`, so the session cannot start.
 *
 * Neither shape is one libi can produce: the only writer is `libi connect`
 * (`lib/cli/connect.ts`), which registers through `codex mcp add … --url`, and
 * the command the Agents page prints for the user is the same HTTP add. They
 * need a hand-written, hand-disabled, or older-libi stdio entry. Deliberately
 * NOT guarded by sniffing the user's `config.toml` here: the check would be a
 * heuristic over a file libi only reads, and a false negative still breaks
 * while a false positive silently restores the twin. Both edges are handled
 * REACTIVELY instead — see `LIBI_MCP_FALLBACK_ENTRY_NAME` and
 * `isLibiMcpEntryConfigError` below for the stdio one, and
 * `lib/codex-config/codex-cli.ts#libiCodexEntryShape` for the disabled one.
 */
export const LIBI_MCP_ENTRY_NAME = "libi";

/**
 * The name libi's ACP entry falls back to when the collision above turns out
 * to be FATAL rather than merely a replacement.
 *
 * The stdio edge documented on `LIBI_MCP_ENTRY_NAME` kills the whole session:
 * codex merges libi's `url` into the user's hand-written stdio
 * `[mcp_servers.libi]`, gets a table carrying both `command` and `url`, and
 * refuses the ENTIRE config — so `thread/start` fails and the user cannot open
 * an in-app Codex chat at all. A dead session is strictly worse than a
 * duplicated tool surface, so when (and only when) that specific failure is
 * observed, `lib/sessions/session-manager.ts` retries ONCE under this name.
 *
 * `libi-app` deliberately, rather than a fresh string: it is the name the
 * in-app entry carried for one release, so `lib/agents/mcp-tool-id.ts`'s
 * `SERVER_ALIASES` already maps it back to `libi` and every tool id, approval
 * gate and progress-bridge lookup keeps resolving. That alias derives its key
 * from THIS constant, so the two cannot drift.
 *
 * The cost of the fallback is the old bug, knowingly re-accepted for the one
 * session that needs it: the name no longer collides, so codex mounts the
 * user's config entry too and the context carries libi twice. Measured on
 * codex-cli 0.153.4 (2026-09-09) driving `codex app-server` directly — a
 * `libi-app` override against a stdio `[mcp_servers.libi]` starts cleanly
 * where the `libi` override returns `-32600 failed to load configuration`.
 * Duplicated schemas beat no chat.
 */
export const LIBI_MCP_FALLBACK_ENTRY_NAME = "libi-app";

/**
 * Every piece of text an ACP rejection carries: its `message`, and its `data` —
 * which codex-acp 1.10.0 shapes differently per call. `session/new` sends the
 * diagnosis as a STRING; `session/load` wraps the same text as
 * `{ details: "…" }` (measured 2026-09-29 on a real install — the matchers
 * below read only strings then, so a refused load never matched and its chat
 * showed a bare "Internal error"). A `data.message` string is read too.
 */
export function rejectionText(err: unknown): string {
  if (typeof err !== "object" || err === null) return "";
  const { data, message } = err as { data?: unknown; message?: unknown };
  const parts: unknown[] = [message];
  if (typeof data === "string") parts.push(data);
  else if (typeof data === "object" && data !== null) {
    const d = data as { details?: unknown; message?: unknown };
    parts.push(d.details, d.message);
  }
  return parts.filter((v): v is string => typeof v === "string").join("\n");
}

/**
 * Is this `newSession` rejection the Codex config collision — and ONLY that?
 *
 * Measured end to end on 2026-09-09 against the real binaries (codex-cli
 * 0.153.4 + codex-acp 1.10.0), driving the adapter over ACP exactly as
 * `process-manager.ts` spawns it. `session/new` comes back as:
 *
 * ```
 * code:    -32603
 * message: "Internal error"
 * data:    "failed to load configuration: url is not supported for stdio\n
 *           in `mcp_servers.libi`\n\n\nCheck <CODEX_HOME> and project .codex
 *           directories, …"
 * ```
 *
 * Note where the signal is NOT: the code is the generic internal-error code and
 * the `message` is the literal string "Internal error" — codex-acp's
 * `handleError` re-wraps anything whose message contains "load config" into
 * `RequestError.internalError(<original text>)`, putting the whole diagnosis in
 * `data`. So the match has to read `data`, and it needs TWO independent parts
 * to be specific:
 *
 *  1. `failed to load configuration` — codex's own wording for a config-layer
 *     rejection, which is also exactly what triggers the codex-acp wrapper.
 *  2. ``in `mcp_servers.<LIBI_MCP_ENTRY_NAME>` `` — the frame naming LIBI'S OWN
 *     entry as the offending table.
 *
 * (2) is what makes this narrow, and it is not a guess about formatting. A
 * config error codex finds by PARSING THE FILE carries a `file:line:col`
 * locator and no table frame — measured on the same day:
 *
 * ```
 * user's own broken [mcp_servers.other]  ->  "…: config.toml:1:1: url is not supported for stdio"
 * malformed TOML                         ->  "…: config.toml:1:18: unclosed table, expected `]`"
 * bad field type on [mcp_servers.libi]   ->  "…: config.toml:3:23: invalid type: string …, expected f64"
 * ```
 *
 * None of those carry the frame, and none of them is fixed by renaming libi's
 * entry — they are the user's config being wrong on its own terms, and must
 * surface as themselves. The frame appears only when the failure comes from
 * MERGING the session override into the config table, which is precisely the
 * case a different name resolves.
 *
 * Everything else is excluded structurally: an auth rejection is `-32000`
 * (`isAuthRequiredError`), a missing binary never reaches `newSession`, and a
 * crashed adapter rejects with a transport error carrying neither string.
 */
export function isLibiMcpEntryConfigError(err: unknown): boolean {
  // The diagnosis lives in `data`; `message` is the generic wrapper. Read both
  // anyway — a future adapter that stops re-wrapping would surface the same
  // text as the message, and matching it there costs nothing.
  const text = rejectionText(err);
  if (!text) return false;
  return (
    /failed to load configuration/i.test(text) &&
    text.includes(`mcp_servers.${LIBI_MCP_ENTRY_NAME}`)
  );
}

/**
 * Which of `names` a codex config rejection names as the offending table, or null.
 *
 * The same two-part match as `isLibiMcpEntryConfigError` — codex's `failed to
 * load configuration` AND the frame naming the table (``in `mcp_servers.<name>` ``),
 * which only a merge of a session override into the config produces — for
 * entries other than libi's own. Used for test mode's fakes, which ride into a
 * Codex session under the names a real entry of the user's may already have
 * (`TEST_MODE_STDIO_FAKE_NAMES` in lib/mcp-config.ts). A name must end where
 * the frame's name ends, so `fal-ai` never matches `fal-ai-2`; a quoted TOML
 * key (`mcp_servers."fal-ai"`) matches too.
 */
export function mcpEntryConfigErrorName(err: unknown, names: readonly string[]): string | null {
  const text = rejectionText(err);
  if (!text || !/failed to load configuration/i.test(text)) return null;
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`mcp_servers\\.(?:"${escaped}"|${escaped}(?![A-Za-z0-9_-]))`).test(text)) return name;
  }
  return null;
}

/**
 * Codex's own diagnosis when it refused its configuration, or null.
 *
 * codex-acp wraps every "failed to load configuration" into `-32603 Internal
 * error` and moves the real text into `data` (see `isLibiMcpEntryConfigError`),
 * so without this a chat shows only "Internal error". Returns the first
 * paragraph after `failed to load configuration:` — the part that names what
 * is wrong — with whitespace collapsed; never the trailing "Check <dirs>"
 * boilerplate, which the caller words itself.
 */
export function agentConfigLoadErrorDetail(err: unknown): string | null {
  const text = rejectionText(err);
  const m = /failed to load configuration:?\s*([\s\S]*?)(?:\n\s*\n|$)/i.exec(text);
  if (!m) return null;
  const detail = m[1].replace(/\s+/g, " ").trim();
  return detail || "its config file could not be read";
}

/**
 * The env var that turns OFF codex-acp's "drop an ACP MCP entry whose name is
 * already in the user's config" filter. libi spawns the ACP child, so it sets
 * this (`lib/agents/process-manager.ts`) and the ACP entry survives to become a
 * per-session config override — which is what makes `LIBI_MCP_ENTRY_NAME`
 * collide-to-replace work on Codex.
 *
 * Read per call from `process.env` in codex-acp 1.10.0
 * (`shouldDeduplicateMcpConflicts()`), so the child env is enough. A canary
 * test asserts the shipped adapter still reads it — if a future adapter drops
 * the flag, the in-app Codex session silently loses its ACP entry (the exact
 * bug the `libi-app` rename was for), and the tool router's in-app-only error
 * is the runtime backstop.
 */
export const CODEX_ACP_DISABLE_MCP_FILTER_ENV = "DISABLE_MCP_CONFIG_FILTERING";

/**
 * Tools registered ONLY when the surface is `in-app` (`mcp/server.ts` wraps
 * them in `if (opts.surface === "in-app")`).
 *
 * Two things read this list, and both are why it is a declared registry rather
 * than an implicit consequence of the `if`:
 *
 *  1. `mcp/http/session.ts` turns a call to one of these on a `cli` session
 *     into a named, actionable error instead of a bare "unknown tool", and
 *     logs it. With the entry names collided (see `LIBI_MCP_ENTRY_NAME`) an
 *     in-app agent should never reach a `cli` session at all, so that error is
 *     also the tripwire for the replacement having failed.
 *  2. A coverage test diffs the two surfaces' registrations against this list,
 *     so gating a new tool without listing it here fails.
 *
 * Add a tool here in the same change that wraps its `registerTool`.
 */
export const IN_APP_ONLY_TOOLS: readonly string[] = ["libi.show_in_chat"];

/** Whether `name` is a tool that exists only on the in-app surface. */
export function isInAppOnlyTool(name: string): boolean {
  return IN_APP_ONLY_TOOLS.includes(name);
}

export function surfaceFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): AgentSurface {
  const raw = headers[SURFACE_HEADER];
  return typeof raw === "string" && raw.toLowerCase() === IN_APP_SURFACE
    ? IN_APP_SURFACE
    : CLI_SURFACE;
}
