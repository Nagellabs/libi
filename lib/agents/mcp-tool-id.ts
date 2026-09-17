import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import {
  LIBI_MCP_ENTRY_NAME,
  LIBI_MCP_FALLBACK_ENTRY_NAME,
} from "@/lib/mcp/agent-surface";

/** Canonical tool ID = `<server-id>:<registered-tool-name>`. Server id is
 *  the bundled.ts MCP key; tool name is whatever was passed to
 *  `server.registerTool(name, …)`, verbatim. Branded so a raw string
 *  can't be passed where a canonical is expected — every call must go
 *  through `makeMcpToolId` or `fromAnyToolName`. */
export type McpToolId = string & { readonly __brand: "McpToolId" };

/** Build a canonical ID from declared parts. Throws if either part is empty. */
export function makeMcpToolId(serverId: string, toolName: string): McpToolId {
  if (!serverId) throw new Error("mcp-tool-id: serverId required");
  if (!toolName) throw new Error("mcp-tool-id: toolName required");
  return `${serverId}:${toolName}` as McpToolId;
}

/** Parse a canonical ID back into its components. Returns null for malformed
 *  input. First colon is the separator; subsequent colons stay in the tool
 *  name (edge case; not used today). Neither half may contain whitespace —
 *  server ids and registered tool names never do, and this keeps prose
 *  titles that happen to contain a colon (`Tool: Read /some/path`) from
 *  masquerading as canonical ids. */
export function parseMcpToolId(id: string): { serverId: string; toolName: string } | null {
  if (!id) return null;
  const colon = id.indexOf(":");
  if (colon <= 0 || colon === id.length - 1) return null;
  const serverId = id.slice(0, colon);
  const toolName = id.slice(colon + 1);
  if (!serverId || !toolName) return null;
  if (/\s/.test(serverId) || /\s/.test(toolName)) return null;
  return { serverId, toolName };
}

const MCP_PREFIX = "mcp__";

/** codex-acp 1.10.0 prefixes an MCP tool-call TITLE with this, then joins the
 *  entry name and the registered tool name with a dot:
 *  `mcp.libi.libi.list_pieces`. Presentation only — see
 *  `fromCodexToolCall` for the structured payload that should be preferred. */
const CODEX_TITLE_PREFIX = "mcp.";

/** Collapse a server identifier to a comparison key: lowercase, with every
 *  run of non-alphanumerics flattened to a single underscore. Bridges the
 *  three spellings of the same server that show up in practice — the bundled
 *  id (`youtube-downloader`), the configured display name the ACP mcpServers
 *  map is keyed by (`YouTube Downloader`), and the wire segment Claude Code
 *  derives from that key (`YouTube_Downloader`). */
function normalizeServerKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Wire segments that mean "libi's own server" but are not a bundled def name.
 *
 * `libi-app` reaches the wire two ways, which is why this alias is not
 * removable:
 *
 *  - HISTORY. For one release the in-app ACP entry was registered under that
 *    name so it could not collide with the `[mcp_servers.libi]` that
 *    `libi connect` writes. The entry is called `libi` again (the collision is
 *    now the mechanism — `lib/mcp/agent-surface.ts#LIBI_MCP_ENTRY_NAME`), but a
 *    resumed session's replayed history and an older adapter still emit it.
 *  - LIVE, on the Codex fallback path. When the collision is fatal rather than
 *    replacing, the session is retried under `LIBI_MCP_FALLBACK_ENTRY_NAME` —
 *    so every tool call in that chat arrives with this segment.
 *
 * A null `toolId` on either would silently blind the jobs progress bridge, the
 * extension approval gate and the tool labels. Both names come from the
 * constants rather than literals so the alias cannot drift away from the entry
 * names it exists to bridge.
 *
 * Keys are NORMALIZED (`normalizeServerKey`), so one entry covers the raw
 * segment (`libi-app`), Claude Code's flattened form (`libi_app`) and any
 * casing a codex title might carry.
 */
const SERVER_ALIASES: Record<string, string> = {
  [normalizeServerKey(LIBI_MCP_FALLBACK_ENTRY_NAME)]: LIBI_MCP_ENTRY_NAME,
};

/** Resolve a wire server segment to a bundled def's canonical id, matching
 *  the normalized segment against both the def id and its display name.
 *  `SERVER_ALIASES` is consulted first so the in-app entry name resolves to
 *  `libi`. Returns null for servers libi doesn't ship (user-installed MCPs). */
function bundledIdForSegment(segment: string): string | null {
  const key = normalizeServerKey(segment);
  if (!key) return null;
  // hasOwn, not a bare index: a user-installed server named `constructor`
  // would otherwise read Object.prototype and come back as a function.
  if (Object.hasOwn(SERVER_ALIASES, key)) return SERVER_ALIASES[key];
  for (const def of BUNDLED_MCP_SERVERS) {
    if (normalizeServerKey(def.id) === key || normalizeServerKey(def.name) === key) {
      return def.id;
    }
  }
  return null;
}

/**
 * Codex's structured MCP tool-call payload, canonicalized.
 *
 * PREFER THIS OVER THE TITLE. codex-acp's `session/update` `tool_call` for an
 * MCP tool carries `rawInput: { server, tool, arguments }` alongside
 * `_meta.is_mcp_tool_call: true`. `server` is the entry name from the ACP
 * `mcpServers` list (or the user's config table) and `tool` is the name the
 * server advertised — i.e. exactly what `server.registerTool(name, …)` was
 * given. That is a data contract; the `title` beside it is a PRESENTATION
 * string and has now changed shape twice (`<server>/<server>.<tool>` on the
 * 0.4x-era adapter, `mcp.<server>.<tool>` on codex-acp 1.10.0). Parsing the
 * title was how every codex MCP call came through with `toolId: null`.
 *
 * Guarded so an ordinary tool whose OWN arguments happen to include `server`
 * and `tool` strings can't masquerade as an MCP envelope: either the codex
 * `_meta` marker must be set, or the payload must carry the third envelope
 * key (`arguments`).
 *
 * Returns null for anything that isn't that envelope — callers fall back to
 * the title.
 */
export function fromCodexToolCall(rawInput: unknown, meta?: unknown): McpToolId | null {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return null;
  const rec = rawInput as Record<string, unknown>;
  const server = typeof rec.server === "string" ? rec.server.trim() : "";
  const tool = typeof rec.tool === "string" ? rec.tool.trim() : "";
  if (!server || !tool) return null;
  // Registered tool names and MCP entry names never contain whitespace.
  if (/\s/.test(server) || /\s/.test(tool)) return null;
  const marked =
    !!meta &&
    typeof meta === "object" &&
    (meta as Record<string, unknown>).is_mcp_tool_call === true;
  if (!marked && !Object.hasOwn(rec, "arguments")) return null;
  // Unknown (user-installed) servers keep their segment verbatim, exactly as
  // the wire-form path does — the UI can still format them.
  return makeMcpToolId(bundledIdForSegment(server) ?? server, tool);
}

/** Normalize a codex-acp tool-call title to the claude wire form
 *  `mcp__<server>__<tool>` so downstream canonicalization + display treat
 *  both agents identically.
 *
 *  A FALLBACK ONLY — prefer `fromCodexToolCall` on the structured `rawInput`.
 *  This exists for a title with no `rawInput` beside it (a replayed part, a
 *  progress update that carries only a label).
 *
 *  Live-captured shapes:
 *    - `mcp.<server>.<tool>` — codex-acp **1.10.0**, e.g.
 *      `mcp.libi-app.libi.list_pieces`. Split at the FIRST dot after `mcp.`:
 *      entry names carry no dot, registered libi tool names do.
 *    - `<server>/<tool>` with an optional `Tool: ` prefix — the older adapter,
 *      e.g. `Tool: libi/libi.list_pieces`.
 *    - `<server>/<tool words>` — spaces join to `_`.
 *
 *  Anything else — a built-in title (`Read`, `Bash`, `Tool: Read /some/path`),
 *  a plain sentence, the claude `mcp__` wire name, or an already-canonical
 *  `<server>:<tool>` id — passes through VERBATIM so a label we don't
 *  recognize is never mangled. Guards: the server segment must be a single
 *  bare token butting the separator, and the tail must never be a slashed
 *  filesystem path.
 *
 *  ONE output rule: everything after the server segment IS the tool name,
 *  verbatim (spaces → `_`). Nothing is stripped from it. The previous version
 *  special-cased a "doubled server" tail and turned `libi/libi.list_pieces`
 *  into `libi:list_pieces` — but `libi.list_pieces` is the whole registered
 *  name (`mcp/server.ts` registers `libi.<tool>`), so that produced an id no
 *  runner, gate or label ever matches, and disagreed with the claude wire form
 *  `mcp__libi__libi_list_pieces` → `libi:libi.list_pieces` for the same call.
 */
export function normalizeCodexToolTitle(raw: string): string {
  if (!raw) return raw;
  // Optional codex `Tool: ` / `Tool ` prefix. Strip it into a candidate; the
  // ORIGINAL raw is returned whenever the candidate doesn't match, so an
  // unrecognized prefixed title is never half-mangled.
  const candidate = raw.replace(/^Tool:?\s+/, "");
  // Leave claude wire names and canonical ids untouched.
  if (candidate.startsWith(MCP_PREFIX)) return raw;
  if (candidate.includes(":")) return raw;

  // codex-acp 1.10.0: `mcp.<server>.<tool>`.
  if (candidate.startsWith(CODEX_TITLE_PREFIX)) {
    const tail = candidate.slice(CODEX_TITLE_PREFIX.length);
    const dot = tail.indexOf(".");
    if (dot <= 0) return raw;
    const server = tail.slice(0, dot);
    const tool = tail.slice(dot + 1);
    if (!server || !tool) return raw;
    if (/\s/.test(tail) || tail.includes("/")) return raw;
    return `${MCP_PREFIX}${server}__${tool}`;
  }

  const slash = candidate.indexOf("/");
  if (slash <= 0) return raw; // no server segment — not a codex MCP title
  const server = candidate.slice(0, slash);
  const rest = candidate.slice(slash + 1);
  if (!server || !rest) return raw;
  // The server segment must be a single contiguous token butting directly up
  // against the slash — `libi/…`, never `Read /some/path` (a built-in title
  // that happens to contain a slashed path). The tail must not itself be
  // slashed (a multi-segment path is a path, not a tool name).
  if (/\s/.test(server) || /^\s/.test(rest) || rest.includes("/")) return raw;

  const tool = rest.split(/\s+/).filter(Boolean).join("_");
  if (!tool) return raw;
  return `${MCP_PREFIX}${server}__${tool}`;
}

/** Normalize ANY incoming tool-name representation to canonical:
 *  - claude-agent-acp wire `mcp__<server>__<tool>` (dot or underscore on the tool half)
 *  - codex-acp `<server>/<tool>` titles (via `normalizeCodexToolTitle`)
 *  - canonical already (`<server>:<tool>`)
 *  - anything else returns null (built-in Claude Code tools, malformed strings)
 *
 *  Wire-form parsing tries every `__` split point and resolves the server
 *  segment against BUNDLED_MCP_SERVERS by normalized id OR display name —
 *  the ACP mcpServers map is keyed by display name (`YouTube Downloader`),
 *  so the wire segment (`YouTube_Downloader`) rarely equals the bundled id
 *  (`youtube-downloader`). The historical in-app entry name
 *  (`libi-app`, see `SERVER_ALIASES`) resolves to `libi` the same way. Bundled matches
 *  canonicalize to the bundled id so downstream id-keyed checks
 *  (the extension approval gate, the jobs progress bridge) stay stable. Unknown servers
 *  — users install MCPs libi has never heard
 *  of — split at the FIRST `__` and keep the segment verbatim, so every
 *  well-formed wire name yields a non-null id and the UI can format it.
 *
 *  The dot/underscore variance on the tool half is reconciled by preferring
 *  the underscore-to-dot conversion ONLY when the server is `libi` or
 *  `libi-tracking` (libi tools are registered with dotted names). For other
 *  servers the tool name passes through verbatim. */
export function fromAnyToolName(raw: string): McpToolId | null {
  if (!raw) return null;

  // codex-acp titles (`libi/libi list pieces`) → claude wire form first, so
  // the parsing below is agent-agnostic. A non-codex title is returned
  // unchanged, keeping the claude `mcp__` path byte-identical.
  raw = normalizeCodexToolTitle(raw);

  // Canonical already — validate and return.
  if (raw.includes(":") && !raw.startsWith(MCP_PREFIX)) {
    const parsed = parseMcpToolId(raw);
    return parsed ? (raw as McpToolId) : null;
  }

  // Wire-form `mcp__<server>__<tool>`.
  if (!raw.startsWith(MCP_PREFIX)) return null;
  const rest = raw.slice(MCP_PREFIX.length);

  // Try every `__` split point against the bundled registry; the longest
  // matching server segment wins (defensive for names that themselves
  // flatten to contain `__` on the wire).
  let matched: { id: string; tool: string; segLen: number } | null = null;
  for (let i = rest.indexOf("__"); i !== -1; i = rest.indexOf("__", i + 1)) {
    const segment = rest.slice(0, i);
    const tool = rest.slice(i + 2);
    if (!segment || !tool) continue;
    const id = bundledIdForSegment(segment);
    if (id && (!matched || segment.length > matched.segLen)) {
      matched = { id, tool, segLen: segment.length };
    }
  }

  let serverId: string;
  let tool: string;
  if (matched) {
    serverId = matched.id;
    tool = matched.tool;
  } else {
    // Unknown server — split at the first `__` and keep the segment verbatim.
    const sep = rest.indexOf("__");
    if (sep <= 0) return null;
    serverId = rest.slice(0, sep);
    tool = rest.slice(sep + 2);
    if (!tool) return null;
  }

  // Libi tools are registered with `libi.<tool>`. If the wire name came through
  // as `libi_<tool>` (underscore on the tool half), recover the dot.
  if ((serverId === "libi" || serverId === "libi-tracking") &&
      tool.startsWith("libi_")) {
    tool = "libi." + tool.slice("libi_".length);
  }

  return makeMcpToolId(serverId, tool);
}

/**
 * Canonicalize one ACP tool call from everything the agent gave us.
 *
 * Structured first (`fromCodexToolCall` — codex-acp's `rawInput.server` /
 * `.tool`, a data contract), then the title (`fromAnyToolName` — claude's wire
 * name, and codex's presentation title as a fallback).
 *
 * This is the entry point every `tool_call` / `tool_call_update` ingest should
 * use. Reaching for `fromAnyToolName` where a `rawInput` is in hand is how
 * codex MCP calls came through with `toolId: null`: the jobs progress bridge,
 * the extension approval gate and the tool labels are all keyed on this id.
 */
export function toolIdForCall(
  title: string | null | undefined,
  rawInput: unknown,
  meta?: unknown,
): McpToolId | null {
  return fromCodexToolCall(rawInput, meta) ?? fromAnyToolName(title ?? "");
}
