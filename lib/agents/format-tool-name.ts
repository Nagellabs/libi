// Pretty-printers for tool calls in the chat UI.
//
// Tool identifiers split into two channels post-canonicalization:
//   - `toolId: McpToolId | null` — canonical `<server>:<tool>` for MCP
//     tools, null for built-in Claude Code tools.
//   - `rawTitle: string` — the original ACP `update.title`, which is
//     already nice for built-ins ("Read /path", "ToolSearch") and the
//     verbose wire name for MCP tools.
//
// `formatToolId` formats the canonical id; `formatBuiltinTitle` is a
// passthrough for the built-in branch. Render with
// `toolId ? formatToolId(toolId) : formatBuiltinTitle(rawTitle)`.

import type { McpToolId } from "@/lib/agents/mcp-tool-id";
import { parseMcpToolId } from "@/lib/agents/mcp-tool-id";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";

const LIBI_PLAIN = /^libi[._]/;

/** Display names of bundled servers keyed by bundled id —
 *  `fromAnyToolName` canonicalizes bundled servers to their id, so the
 *  pretty label comes from the def, not from the raw id. */
const BUNDLED_NAME_BY_ID = new Map<string, string>(
  BUNDLED_MCP_SERVERS.map((m) => [m.id, m.name]),
);

/** Pretty-print a canonical MCP tool ID for the chat UI.
 *
 *  Works for ANY server — bundled ids resolve to their display name; unknown
 *  (user-installed) servers are prettified generically from the wire segment.
 *
 *  Examples:
 *    "libi:libi.compute_object_track"          → "Libi Compute object track"
 *    "libi-tracking:libi.compute_object_track" → "Libi Compute object track"
 *    "youtube-downloader:ytdlp_search_videos"  → "YouTube Downloader Ytdlp search videos"
 *    "elevenlabs:text_to_speech"               → "ElevenLabs Text to speech"
 *    "fal-ai:generate_image"                   → "fal-ai Generate image"
 *    "My_Custom_MCP:do_thing"                  → "My Custom MCP Do thing"
 */
export function formatToolId(id: McpToolId): string {
  const parsed = parseMcpToolId(id);
  if (!parsed) return id;
  const { serverId, toolName } = parsed;
  if (serverId === "libi" || serverId === "libi-tracking") {
    return formatLibiName(toolName);
  }
  const serverLabel = formatServerLabel(serverId);
  const toolLabel = formatActionPart(toolName);
  return toolLabel ? `${serverLabel} ${toolLabel}` : serverLabel;
}

/** Server segment → display label. Bundled ids use the def's display name;
 *  anything else (user-installed MCPs) swaps underscores for spaces and,
 *  when the user's name carries no casing of its own, capitalizes the
 *  first letter. Mixed-case names ("My_Custom_MCP") keep their casing. */
function formatServerLabel(serverId: string): string {
  const bundledName = BUNDLED_NAME_BY_ID.get(serverId);
  if (bundledName) return bundledName;
  const label = serverId.replace(/_+/g, " ").trim();
  if (label && label === label.toLowerCase()) {
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  return label;
}

/** Format a built-in Claude Code tool title (Read/Edit/Bash/ToolSearch/…)
 *  for the chat UI. Pass-through — these titles arrive pretty already. */
export function formatBuiltinTitle(rawTitle: string): string {
  return rawTitle;
}

/** "<libi-stripped-tool>" → "Libi <Action>" */
function formatLibiName(tool: string): string {
  const stripped = tool.replace(LIBI_PLAIN, "");
  const action = formatActionPart(stripped);
  return action ? `Libi ${action}` : "Libi";
}

/** "speech_to_text" → "Speech to text"; "analysis.describe_frame" → "Analysis describe frame" */
function formatActionPart(s: string): string {
  const parts = s.split(/[._]/).filter(Boolean);
  if (parts.length === 0) return "";
  const head = parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
  const tail = parts.slice(1).join(" ");
  return tail ? `${head} ${tail}` : head;
}

/**
 * libi MCP tools wrap every response in `{ success: boolean, data?: …,
 * error?: string }`. When that envelope shows up inside a tool result's
 * text block, peel it: surface the `data` field for successes and the
 * `error` field for failures so the UI doesn't show JSON-wrapped JSON.
 *
 * Returns the unwrapped value (a JS value, NOT a string) when the input
 * was a libi envelope; null otherwise.
 */
function peelLibiEnvelope(text: string): { value: unknown } | null {
  if (!text || text[0] !== "{") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.success !== "boolean") return null;
  if (obj.success === false) {
    return { value: typeof obj.error === "string" ? obj.error : "failed" };
  }
  if ("data" in obj) return { value: obj.data ?? "ok" };
  return { value: "ok" };
}

/**
 * Try to JSON-parse a string. Returns the parsed value (which may itself
 * be a string, array, object, etc.) or null if it doesn't parse.
 *
 * Used to recover structure from tool-result text blocks that contain
 * compact JSON without the libi envelope (e.g. skill-tools' `ok()` helper
 * passes the payload to JSON.stringify directly).
 */
function tryParseJson(text: string): unknown | null {
  if (!text) return null;
  const first = text.trimStart()[0];
  if (first !== "{" && first !== "[") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Headline-quality fields, in priority order. The first one that
 *  exists with a non-empty string/number/boolean value becomes the
 *  summary's anchor — e.g. `{id, name, description}` → "Mimic Video
 *  Project · description: Analysis-driven recreation…". */
const HIGHLIGHT_FIELDS = [
  "name",
  "title",
  "label",
  "filename",
  "path",
  "url",
  // Content-bearing fields used by analysis tools and similar.
  "scene",
  "summary",
  "message",
  "text",
];

/** Fields we'd rather hide in summaries when richer content exists.
 *  These match `id`, `*Id`, `*_id`, plus opaque schema/version stamps. */
function isIdLikeKey(key: string): boolean {
  if (key === "id") return true;
  if (key.endsWith("Id") || key.endsWith("_id")) return true;
  if (key === "schema_version" || key === "schemaVersion") return true;
  return false;
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** Truncate a string for inline display. Used to keep the summary short
 *  enough to fit on one line. */
function clip(s: string, max = 60): string {
  const oneLine = String(s).replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/**
 * Best-effort short summary of a structured result. ALWAYS returns a
 * string for objects/arrays so the renderer never falls through to a
 * raw JSON block — the user should never see `{"id": "…", "name": "…"}`
 * inline regardless of which tool produced the value.
 *
 * Heuristics in priority order:
 *   - Bare scalars                → stringified
 *   - Bare arrays of objects      → "3 items · <highlight of first>"
 *   - Bare arrays of scalars      → "3 items"
 *   - Single-key array wrapper    → "3 servers" / "1 piece"
 *   - Single-key scalar wrapper   → "id: abc"
 *   - Single-key object wrapper   → "key: <recursive summary>"
 *   - Objects with arrays inside  → "5 results, 2 errors"
 *   - Objects with a HIGHLIGHT    → "name (description)" / "name (key: v)"
 *   - Plain scalar bag            → "key: value, key: value"
 */
function summarizeStructured(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const count = value.length;
    const head = `${count} item${count === 1 ? "" : "s"}`;
    if (count === 0) return head;
    const first = value[0];
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const inner = describeObject(first as Record<string, unknown>);
      if (inner) return `${head} · ${clip(inner, SUMMARY_MAX_CHARS - head.length - 4)}`;
    }
    return head;
  }
  if (typeof value !== "object") return null;

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return null;

  // Single-key wrapper around an array — extremely common shape from list
  // tools (`{servers: [...]}, {pieces: [...]}`).
  if (keys.length === 1 && Array.isArray(obj[keys[0]])) {
    const key = keys[0];
    const arr = obj[key] as unknown[];
    const count = arr.length;
    const noun = count === 1 ? singularize(key) : key;
    return `${count} ${noun}`;
  }

  // Single-key wrapper around a scalar — e.g. `{id: "abc"}` from a
  // create-* tool. Render as "key: value".
  if (keys.length === 1 && isScalar(obj[keys[0]])) {
    return `${keys[0]}: ${obj[keys[0]]}`;
  }

  // Single-key wrapper around an object — surface the key and recurse.
  if (keys.length === 1 && obj[keys[0]] && typeof obj[keys[0]] === "object") {
    const inner = summarizeStructured(obj[keys[0]]);
    return inner ? `${keys[0]}: ${inner}` : null;
  }

  // Multiple top-level array keys — list each with its count so the user
  // gets a sense of shape without expanding the JSON block.
  const arrayParts: string[] = [];
  for (const k of keys) {
    if (Array.isArray(obj[k])) {
      const count = (obj[k] as unknown[]).length;
      arrayParts.push(`${count} ${count === 1 ? singularize(k) : k}`);
    }
  }
  if (arrayParts.length > 0) return arrayParts.join(", ");

  // Generic plain-object case — pick a highlight field, otherwise list
  // the first 1-2 non-id scalar fields. Either way we ALWAYS return
  // a string here so the caller never falls through to a JSON block.
  return describeObject(obj);
}

/** Sub-helper for describing an object via highlight + supporting field. */
function describeObject(obj: Record<string, unknown>): string | null {
  // Highlight: prefer human-readable headline fields.
  for (const k of HIGHLIGHT_FIELDS) {
    if (isScalar(obj[k]) && String(obj[k]).length > 0) {
      const headline = String(obj[k]);
      // If a description exists and isn't a duplicate of headline, append it.
      if (
        typeof obj.description === "string" &&
        obj.description &&
        obj.description !== headline
      ) {
        return `${clip(headline, 50)} · ${clip(obj.description, 60)}`;
      }
      return clip(headline, SUMMARY_MAX_CHARS - 1);
    }
  }
  // No headline. Pick the most informative scalar fields. Skip ID-like
  // ones if any non-id scalars exist.
  const scalarFields = Object.entries(obj).filter(([, v]) => isScalar(v));
  if (scalarFields.length === 0) {
    return null;
  }
  const nonId = scalarFields.filter(([k]) => !isIdLikeKey(k));
  const picked = nonId.length > 0 ? nonId : scalarFields;
  const rendered = picked
    .slice(0, 2)
    .map(([k, v]) => `${k}: ${clip(String(v), 30)}`)
    .join(", ");
  return rendered || null;
}

/**
 * Detect an MCP error envelope (the JSON-RPC error object MCP servers
 * return when a tool call fails) and produce a short, human-friendly
 * summary. Falls back to the input string when nothing matches so
 * `extractResultPreview` can decide whether to render summary or block.
 *
 * Examples:
 *   "MCP error -32602: Input validation error: Invalid arguments for
 *    tool libi.x: [{ \"code\": \"invalid_type\", \"path\": [\"count\"],
 *    \"message\": \"Expected number, received string\" }]"
 *   →  "count: Expected number, received string"
 */
function summarizeMcpError(text: string): string | null {
  // No `/s` flag — instead match the prefix and slice the remainder.
  const m = text.match(/^MCP error -?\d+:\s*/);
  if (!m) return null;
  const rest = text.slice(m[0].length).trim();
  // Try to extract Zod error array — its format is stable.
  const arrStart = rest.indexOf("[");
  if (arrStart >= 0) {
    try {
      const arr = JSON.parse(rest.slice(arrStart));
      if (Array.isArray(arr) && arr.length > 0) {
        const first = arr[0] as { path?: unknown[]; message?: string; code?: string };
        const pathStr = Array.isArray(first.path) ? first.path.join(".") : "";
        const msg = first.message ?? first.code ?? "validation failed";
        const more = arr.length > 1 ? ` (+${arr.length - 1} more)` : "";
        return clip(pathStr ? `${pathStr}: ${msg}${more}` : `${msg}${more}`, SUMMARY_MAX_CHARS);
      }
    } catch {
      /* fall through to prefix-only */
    }
    return clip(rest.slice(0, arrStart).trim(), SUMMARY_MAX_CHARS);
  }
  return clip(rest, SUMMARY_MAX_CHARS);
}

function singularize(s: string): string {
  if (s.endsWith("ies") && s.length > 3) return s.slice(0, -3) + "y";
  if (s.endsWith("s") && !s.endsWith("ss")) return s.slice(0, -1);
  return s;
}

/**
 * One-line summary ("3 servers", "2 pieces", "ok") or multi-line code
 * block (pretty-printed JSON, raw text). The renderer picks styling:
 * `summary` is shown inline as a small grey line, `block` is shown as a
 * styled monospace card under the tool call.
 */
export type ResultPreview =
  | { kind: "summary"; text: string }
  | { kind: "block"; text: string };

const SUMMARY_MAX_CHARS = 100;

/**
 * Build a UI preview of a tool's result. Handles every shape the agent
 * can hand us:
 *   - bare strings
 *   - bare MCP content arrays (claude-agent-acp delivers `rawOutput` as
 *     a `[{type:"text", text:"…"}, …]` array directly, not wrapped)
 *   - `{content: [...]}` wrappers (older shape)
 *   - libi `{success, data}` envelopes nested inside text blocks
 *   - non-enveloped JSON payloads (skill-tools.ts uses a local `ok()`
 *     helper that just `JSON.stringify`s the payload)
 *
 * The function tries to summarize structured payloads ("3 servers",
 * "2 pieces") so the user sees a friendly one-liner instead of staring
 * at a JSON blob. Falls back to pretty-printed JSON when nothing
 * snappy applies.
 *
 * Returns null only when the result is empty.
 */
export function extractResultPreview(result: unknown): ResultPreview | null {
  if (result == null) return null;
  if (typeof result === "string") {
    const trimmed = result.trim();
    if (!trimmed) return null;
    return previewFromValue(trimmed);
  }
  if (typeof result !== "object") return { kind: "summary", text: String(result) };

  // Find an MCP-style content array — bare array, or `.content` on an object.
  const items: unknown[] | null = Array.isArray(result)
    ? result
    : Array.isArray((result as Record<string, unknown>).content)
      ? ((result as Record<string, unknown>).content as unknown[])
      : null;

  if (items) {
    const texts: string[] = [];
    for (const c of items) {
      if (c && typeof c === "object") {
        const item = c as Record<string, unknown>;
        if (item.type === "text" && typeof item.text === "string") {
          texts.push(item.text);
        }
      }
    }
    if (texts.length > 0) {
      const joined = texts.join("\n").trim();
      // Peel the libi envelope first; otherwise try parsing the joined
      // text as JSON ourselves so non-enveloped tools (skill-tools) get
      // the same treatment.
      const peeled = peelLibiEnvelope(joined);
      if (peeled) return previewFromValue(peeled.value);

      // MCP transport errors (`MCP error -32602: …`) come through as
      // plain text — distill the Zod path/message rather than dumping
      // the raw error object on the user.
      const mcpErr = summarizeMcpError(joined);
      if (mcpErr) return { kind: "summary", text: mcpErr };

      const parsed = tryParseJson(joined);
      if (parsed !== null) return previewFromValue(parsed);

      return { kind: "summary", text: joined };
    }
    // No `text` blocks — array of structured items (e.g. ToolSearch's
    // tool_reference blocks). Try a summary; fall back to a JSON block.
    return previewFromValue(items);
  }

  // Top-level libi envelope (some tools return one bare).
  const obj = result as Record<string, unknown>;
  if (typeof obj.success === "boolean") {
    if (obj.success === false) {
      return {
        kind: "summary",
        text: typeof obj.error === "string" ? obj.error : "failed",
      };
    }
    if ("data" in obj) return previewFromValue(obj.data ?? "ok");
    return { kind: "summary", text: "ok" };
  }

  return previewFromValue(result);
}

/**
 * Bridge any JS value into a ResultPreview. Used from the various paths
 * in extractResultPreview — arrays, peeled envelopes, parsed JSON, etc.
 */
function previewFromValue(value: unknown): ResultPreview | null {
  if (value == null) return null;

  // Strings: try MCP-error → JSON parse → summary/block decision.
  // The JSON parse step catches MCP tool results that arrive as a
  // top-level JSON-stringified payload (e.g. ElevenLabs speech_to_text
  // returns `{"result":{"type":"text","text":"…"}}`). Without the parse
  // these long single-line strings would render as a raw `kind: "block"`
  // JSON dump — exactly the user-visible bug we're fixing.
  // Single-line strings (any length) become summaries — clipped if
  // needed — because they're typically conversational content like a
  // transcript. Multi-line strings stay as blocks where their structure
  // (logs, JSON, code) carries information.
  if (typeof value === "string") {
    const mcpErr = summarizeMcpError(value);
    if (mcpErr) return { kind: "summary", text: mcpErr };
    const parsed = tryParseJson(value);
    if (parsed !== null && (typeof parsed === "object" || Array.isArray(parsed))) {
      const peeled = peelMcpResult(parsed);
      const fromStructured = previewFromValue(peeled);
      if (fromStructured) return fromStructured;
    }
    if (value.includes("\n")) return { kind: "block", text: value };
    if (value.length <= SUMMARY_MAX_CHARS) {
      return { kind: "summary", text: value };
    }
    return { kind: "summary", text: value.slice(0, SUMMARY_MAX_CHARS - 1) + "…" };
  }

  // Peel a top-level `{result: …}` wrapper (common MCP shape) so the
  // summary is anchored on the actual payload instead of "result: …".
  const peeled = peelMcpResult(value);

  // Structured value — `summarizeStructured` is now exhaustive for
  // arrays and plain objects, so we always end up with a summary string
  // (clipped if needed). The user explicitly asked NOT to fall back to
  // raw JSON for unknown shapes.
  const summary = summarizeStructured(peeled);
  if (summary) {
    const text = summary.length <= SUMMARY_MAX_CHARS
      ? summary
      : summary.slice(0, SUMMARY_MAX_CHARS - 1) + "…";
    return { kind: "summary", text };
  }

  // Empty `{}` or unrenderable value → no preview at all.
  return null;
}

/**
 * Peel common MCP result wrappers so the summary anchors on the real
 * payload. Two shapes:
 *   - `{result: X}`            → recurse into X
 *   - `{type: "text", text: X}` → return the text string directly
 *
 * Both are MCP-content conventions — the wrapper key carries no
 * information that helps a chat preview, so unwrapping leads to a
 * cleaner one-liner ("I'm just finishing work…" vs "result: I'm just…").
 */
function peelMcpResult(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0] === "result") {
    return peelMcpResult(obj.result);
  }
  if (
    keys.length === 2 &&
    obj.type === "text" &&
    typeof obj.text === "string"
  ) {
    return obj.text;
  }
  return value;
}

/**
 * Back-compat shim — older callers that just want a string preview.
 * Prefer `extractResultPreview` for new code so the renderer can style
 * summary vs block differently.
 */
export function extractResultText(result: unknown): string | null {
  return extractResultPreview(result)?.text ?? null;
}

/**
 * Pretty-print a subagent's stored result for the expanded card view.
 * Subagent results land as a JSON-stringified MCP content array (e.g.
 * `[{"type":"text","text":"…"}]`) — the literal `<pre>` dump exposes
 * all the escape characters and the wrapper noise. This helper:
 *
 *   1. Parses the outer JSON. If it's a content array with text blocks,
 *      joins their `text` fields.
 *   2. If the resulting string is itself JSON, pretty-prints it.
 *   3. If the string starts with JSON followed by trailing prose
 *      (common pattern: a frame_v1 array followed by an
 *      ARTIFACT_MAPPING and OVERALL_STYLE summary), pretty-prints just
 *      the leading JSON and keeps the prose on subsequent lines.
 *   4. Falls through to the original string when nothing matches so we
 *      never lose data.
 */
export function formatSubagentResult(raw: string): string {
  if (!raw) return raw;
  const outer = tryParseJson(raw);
  let inner: string = raw;
  if (Array.isArray(outer)) {
    const texts: string[] = [];
    for (const item of outer) {
      if (item && typeof item === "object") {
        const block = item as Record<string, unknown>;
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        }
      }
    }
    if (texts.length > 0) inner = texts.join("\n").trim();
  } else if (outer !== null && typeof outer === "object") {
    // Some tools return a single object — pretty-print it.
    return JSON.stringify(outer, null, 2);
  }
  // If the unwrapped inner text is itself JSON, pretty-print it.
  const innerParsed = tryParseJson(inner);
  if (innerParsed !== null && typeof innerParsed === "object") {
    return JSON.stringify(innerParsed, null, 2);
  }
  // Common Task pattern: a JSON array/object at the start, then
  // free-form notes. Pretty-print the leading JSON and keep the prose.
  const split = splitLeadingJson(inner);
  if (split) {
    const parsed = tryParseJson(split.json);
    if (parsed !== null && typeof parsed === "object") {
      return JSON.stringify(parsed, null, 2) + "\n\n" + split.rest.trim();
    }
  }
  return inner;
}

/**
 * Find the leading balanced JSON array or object in `text` and return
 * the JSON substring + the remainder. Returns null when the leading
 * structure isn't valid JSON or there's nothing after it (the pure-JSON
 * case is already handled by the caller).
 *
 * Walks the text counting brackets while respecting JSON string
 * literals and escapes — naive index-based slicing would cut inside a
 * string when the payload contains `]` or `}` characters.
 */
function splitLeadingJson(
  text: string,
): { json: string; rest: string } | null {
  const trimmed = text.trimStart();
  const offset = text.length - trimmed.length;
  const open = trimmed[0];
  if (open !== "[" && open !== "{") return null;
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        const end = i + 1;
        const rest = trimmed.slice(end);
        if (!rest.trim()) return null; // pure JSON — handled elsewhere
        return { json: trimmed.slice(0, end), rest };
      }
    }
  }
  return null;
}
