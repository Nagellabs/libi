/**
 * The extension approval gate: does this tool belong to a libi extension the
 * user marked "requires approval" in Settings?
 *
 * LIMITATIONS
 * - The gate applies to Claude in-app sessions. claude-agent-acp routes every
 *   non-read-only tool call (including every MCP tool) through libi's
 *   `canUseTool` handler in `default` mode, with the tool's `mcp__server__tool`
 *   name as the request title — that is what `decidePermissionAction` keys on.
 * - For Codex the gate is NOT IMPLEMENTED. It is not impossible — that was
 *   this note's claim until a live spike disproved it on codex CLI 0.153.4 /
 *   codex-acp 1.10.0 (2026-09-09). Codex core DOES emit the MCP-tool-call
 *   approval (`_meta.is_mcp_tool_approval: true`), and while the request
 *   itself carries no name, the `session/update` `tool_call` delivered
 *   immediately before it on the same session carries the SAME `toolCallId`
 *   plus `rawInput: { server, tool }`. Correlating the two names the tool.
 *   Building it needs a `toolCallId → McpToolId` map in
 *   `SessionEventHandler`, read by `decidePermissionAction` when
 *   `extractToolMeta` yields null.
 *
 *   Note the narrower promise it could keep: the approval only ever FIRES in
 *   libi's `ask` mode. In `auto` / `auto-with-generations` codex's own
 *   Guardian approves MCP calls and libi is never asked.
 *
 *   Until that lands, `requireApproval` on an extension is ADVISORY for Codex
 *   — the manual's REQUIRES APPROVAL prose is what asks the agent to confirm;
 *   nothing in-app enforces it.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { extensionForToolName } from "@/mcp/registry/bundled";
import { parseMcpToolId, type McpToolId } from "@/lib/agents/mcp-tool-id";

/** Server ids that carry libi's own tools. Only these can own an extension
 *  tool; a provider MCP's tool never reaches the DB read. */
const LIBI_SERVER_IDS: ReadonlySet<string> = new Set(["libi", "libi-tracking"]);

/**
 * Each extension's install-path tools. They resolve to the extension via its
 * `toolPrefixes` like any other tool, but they are the way the user gets past
 * "not installed" — holding them behind the extension's own approval flag
 * would leave a `needs_install` result with no unprompted way out.
 * `libi.verify_install` is the read-only "is the tracking engine installed?"
 * check on that same path: gating it would gate the question, not the
 * install. Registered names, verbatim (`mcp/server.ts`, `mcp/tracking-mcp/`).
 */
const EXTENSION_INSTALL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "libi.install_tracking_engine",
  "libi.verify_install",
  "libi.whisper_download_model",
  "libi.tts_download_model",
  "libi.music_download_model",
  "libi.music_install_analysis_deps",
]);

/** True when `toolName` (the registered name, e.g. `libi.music_download_model`)
 *  is one of the extension install-path tools exempt from the gate. */
export function isExtensionInstallTool(toolName: string): boolean {
  return EXTENSION_INSTALL_TOOL_NAMES.has(toolName);
}

/**
 * True when `toolId` belongs to a libi extension whose row has
 * `requireApproval = true`.
 *
 * This replaces the deleted `generation: true` gate. The difference is what it
 * gates: `generation` gated a THIRD-PARTY MCP that spends the user's money;
 * this gates a LIBI extension that spends the user's disk, GPU or minutes.
 * A provider MCP's own approval behaviour is the agent's business, not libi's
 * — libi does not manage those servers.
 *
 * Only libi's own tool ids can match, so a provider tool never reaches the DB
 * read. Built-in tools (toolId === null) and the extensions' own install
 * tools (`isExtensionInstallTool`) are never gated.
 */
export function isApprovalRequiredExtensionTool(toolId: McpToolId | null): boolean {
  if (!toolId) return false;
  const parsed = parseMcpToolId(toolId);
  if (!parsed) return false;
  if (!LIBI_SERVER_IDS.has(parsed.serverId)) return false;
  if (isExtensionInstallTool(parsed.toolName)) return false;
  const def = extensionForToolName(parsed.toolName);
  if (!def) return false;
  try {
    const row = getDb()
      .select({ requireApproval: mcpServers.requireApproval })
      .from(mcpServers)
      .where(eq(mcpServers.id, def.id))
      .get();
    // No row (a DB that predates the def) means the def's own default applies.
    return row ? row.requireApproval : def.requireApproval;
  } catch {
    // DB unavailable — fall back to the def, never to "no approval needed".
    return def.requireApproval;
  }
}
