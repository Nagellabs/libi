import { z } from "zod/v3";
import * as tools from "@/mcp/tools";
import { retryMcpServer } from "@/mcp/tools/mcp-retry-tools";
import { recheckMcp, restartAcpSession } from "@/mcp/bundled-mcps/install-tools";
import { diagnoseMcp } from "@/mcp/bundled-mcps/diagnose";
import { restartMcpServer } from "@/mcp/bundled-mcps/restart-mcp";
import {
  updateMcpServerSchema,
  retryMcpServerSchema,
  recheckMcpSchema,
  restartAcpSessionSchema,
  diagnoseMcpSchema,
  restartMcpServerSchema,
} from "@/mcp/tools/schemas";
import { action, sessionIdOf, type ActionToolDef } from "@/mcp/tools/action-tool";

// None of these six sits under an extension's `toolPrefixes` (mcp/registry/bundled.ts), so none is
// approval-gated: the install flow (libi.get_install_plan / update_dep_status) stays separate.
export const extensionTool: ActionToolDef = {
  name: "libi.extension",
  description:
    "Troubleshoot libi's own extensions (tracking, whisper, local TTS, local music, video download): diagnose a broken one, recheck/retry/restart its MCP server, reload the chat session, turn ON its approval prompt. Actions: diagnose, recheck, retry, restart, update, restart_session.",
  // `retry` insists on a non-empty id, the others take any string: advertise the loosest, each action still enforces its own.
  widen: { mcpId: z.string() },
  props: {
    mcpId: "Id of the libi extension, e.g. 'libi-tracking', 'whisper', 'local-music'.",
    id: "update: the extension's id (`mcpId` is accepted too).",
    requireApproval: "true = prompt the user before every tool this extension owns; false is refused (only the user turns it off, under Agents → Libi MCP).",
  },
  actions: {
    diagnose: action({
      describe:
        "state snapshot of an extension: install/server status, spawn config (env keys only), whether it is in your session, auxiliary checks (binary, model) and hints. Call it FIRST when an extension seems broken",
      schema: diagnoseMcpSchema,
      run: (params) => diagnoseMcp(params),
    }),
    recheck: action({
      describe:
        "probe an extension's MCP server handshake: up/down plus its tools; call it after install steps to verify the server boots",
      schema: recheckMcpSchema,
      run: (params) => recheckMcp(params),
    }),
    retry: action({
      describe:
        "re-probe an extension's MCP server and refresh its serverStatus (when the user reports it down on Agents → Libi MCP); a recovered server reaches NEW chats only",
      schema: retryMcpServerSchema,
      run: (params) => retryMcpServer(params),
    }),
    restart: action({
      describe:
        "restart an extension's MCP server after fixing what `diagnose` found; returns at once. Every libi extension restarts together, so ask the user to open a new chat or re-send to pick up the rebuilt list",
      schema: restartMcpServerSchema,
      run: (params, extra) => restartMcpServer(params, { sessionId: sessionIdOf(extra) }),
    }),
    update: action({
      describe:
        "turn ON an extension's approval prompt (`requireApproval: true`); off is the user's, under Agents → Libi MCP. No other field is editable, and libi holds no provider credentials",
      schema: updateMcpServerSchema,
      // The other five name the extension `mcpId`; a model that carries that spelling over is not refused for it.
      aliases: { mcpId: "id" },
      // The ON-only rule lives in updateMcpServer itself (mcp/tools/mcp-server-tools.ts), where the route's own check also reads it.
      run: (params) => tools.updateMcpServer(params),
    }),
    restart_session: action({
      describe:
        "reload the whole ACP session (every libi extension restarts); only with no specific extension to target (else `restart`), after installing one and `update_dep_status` 'installed'. Then end your turn and tell the user: 'Installed — please open a new chat and re-send your request to use the new tools.' (MCP servers load at session creation)",
      schema: restartAcpSessionSchema,
      run: (params, extra) => restartAcpSession(params, { sessionId: sessionIdOf(extra) }),
    }),
  },
};
