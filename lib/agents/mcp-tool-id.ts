import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";

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

/** Resolve a wire server segment to a bundled def's canonical id, matching
 *  the normalized segment against both the def id and its display name.
 *  Returns null for servers libi doesn't ship (user-installed MCPs). */
function bundledIdForSegment(segment: string): string | null {
  const key = normalizeServerKey(segment);
  if (!key) return null;
  for (const def of BUNDLED_MCP_SERVERS) {
    if (normalizeServerKey(def.id) === key || normalizeServerKey(def.name) === key) {
      return def.id;
    }
  }
  return null;
}

/** Normalize a codex-acp tool-call title to the claude wire form
 *  `mcp__<server>__<tool>` so downstream canonicalization + display treat
 *  both agents identically.
 *
 *  Live-captured shape (the REAL one, from `/api/agent/messages` on a codex
 *  `libi.list_pieces` call):
 *    - `Tool: <server>/<server>.<tool>` — e.g. `Tool: libi/libi.list_pieces`
 *      (optional `Tool: ` prefix; the tail after `/` is the fully-qualified
 *      dotted MCP tool name, so the server name appears TWICE)
 *  Defensive variants also recognized:
 *    - `<server>/<server> <tool words>` — e.g. `libi/libi list pieces`
 *    - `<server>/<tool>` — e.g. `libi/list_pieces`
 *
 *  We recognize ONLY these `<server>/…` shapes (with or without the `Tool: `
 *  prefix). Anything else — a built-in title (`Read`, `Bash`,
 *  `Tool: Read /some/path`), a plain sentence, the claude `mcp__` wire name,
 *  or an already-canonical `<server>:<tool>` id — passes through VERBATIM so
 *  a label we don't recognize is never mangled. Guards: the server segment
 *  must be a single bare token butting the slash, and the tail must be a
 *  dotted/spaced tool name, never a slashed filesystem path.
 *
 *  Output convention: a doubled-server dotted tail drops its `<server>.`
 *  prefix (`libi/libi.list_pieces` → tool `list_pieces`); `<tool words>` →
 *  snake_case (spaces → `_`) with a duplicated leading server word dropped;
 *  the `<server>/<tool>` slug form keeps its tool verbatim. */
export function normalizeCodexToolTitle(raw: string): string {
  if (!raw) return raw;
  // Optional codex `Tool: ` / `Tool ` prefix. Strip it into a candidate; the
  // ORIGINAL raw is returned whenever the candidate doesn't match, so an
  // unrecognized prefixed title is never half-mangled.
  const candidate = raw.replace(/^Tool:?\s+/, "");
  // Leave claude wire names and canonical ids untouched.
  if (candidate.startsWith(MCP_PREFIX)) return raw;
  if (candidate.includes(":")) return raw;

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

  let tool: string;
  if (rest.startsWith(`${server}.`)) {
    // The REAL doubled-server dotted form: `libi/libi.list_pieces`. The tail
    // is the fully-qualified `<server>.<tool>` — drop the server prefix.
    tool = rest.slice(server.length + 1);
  } else {
    let words = rest.split(/\s+/).filter(Boolean);
    if (words.length === 0) return raw;
    // Drop the duplicated leading server word (`libi/libi list pieces`).
    if (words.length > 1 && words[0] === server) {
      words = words.slice(1);
    }
    tool = words.join("_");
  }
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
 *  (`youtube-downloader`). Bundled matches canonicalize to the bundled id so
 *  downstream id-keyed checks (isGenerationTool, the jobs progress bridge)
 *  stay stable. Unknown servers — users install MCPs libi has never heard
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
