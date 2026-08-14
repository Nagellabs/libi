import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import { getSessionManager } from "@/lib/sessions/session-manager";
import { invalidateMcpConfig } from "@/lib/mcp-config";
import { serverLogger } from "@/lib/logger";
import { getDb } from "@/lib/db/client";
import { mcpServers as mcpServersTable } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export interface RestartMcpServerInput {
  mcpId: string;
}

export interface RestartMcpServerContext {
  sessionId: string;
}

export type RestartMcpServerResult =
  | { success: true; mcpId: string; message: string }
  | { success: false; error: string };

/**
 * Restart a bundled MCP server. Per spike findings
 * (docs-local/superpowers/plans/spikes/2026-05-15-restart-mcp.md), claude-agent-acp
 * doesn't expose per-MCP restart — the only ACP-level lever is whole-session
 * reload via SessionManager.scheduleSessionReload. So this tool:
 *
 *   1. Invalidates the mcp-config cache (forces fresh resolution next time)
 *   2. Schedules a session reload — the current ACP session is torn down and
 *      recreated with the fresh mcpServers list
 *   3. Returns a message telling the agent its turn is ending (the in-flight
 *      prompt gets cancelled by the reload — same as restart_acp_session)
 *
 * All MCPs restart together — not just the target. Acceptable trade-off
 * given the lack of upstream support for narrower restart. If
 * `claude-agent-acp` ever forwards `Query.reconnectMcpServer`, this becomes
 * a per-MCP operation.
 */
export async function restartMcpServer(
  input: RestartMcpServerInput,
  ctx: RestartMcpServerContext,
): Promise<RestartMcpServerResult> {
  // BUNDLED_MCP_SERVERS is evaluated at module-load. If LIBI_TEST_MODE was
  // unset at that moment (e.g. a Next.js worker process started before the
  // env propagated), the in-memory array may not reflect the live runtime
  // state. Fall back to the DB lookup so any MCP the agent can see via
  // libi.list_mcp_servers is restartable.
  let def: { id: string; name: string } | undefined =
    BUNDLED_MCP_SERVERS.find((d) => d.id === input.mcpId);
  if (!def) {
    const row = getDb()
      .select({ id: mcpServersTable.id, name: mcpServersTable.name })
      .from(mcpServersTable)
      .where(eq(mcpServersTable.id, input.mcpId))
      .get();
    if (row) def = row;
  }
  if (!def) {
    return { success: false, error: `Unknown MCP id "${input.mcpId}".` };
  }
  serverLogger.info(
    {
      tag: "mcp-config",
      op: "restart_mcp_server",
      mcpId: input.mcpId,
      sessionId: ctx.sessionId || null,
    },
    `Restarting MCP "${input.mcpId}" via whole-session reload (Path B per spike)`,
  );

  // Bust the cache so the next session build rebuilds the mcpServers list from
  // fresh DB state. With the globalThis-backed mcp-config cache, this ALSO
  // refreshes the standby session via the shared invalidate callback — so a
  // brand-new chat picks up the rebuilt MCP list even when we can't reload the
  // current session below. Right hygiene after libi.update_dep_status, too.
  invalidateMcpConfig({ reason: "agent-restart-mcp" });

  // The ACP session id is threaded from the MCP request `_meta` by
  // claude-agent-acp. It isn't always present (a known adapter gap on some
  // tool calls). When we DO have it, tear the current session down and
  // recreate it with the fresh mcpServers list (the in-flight prompt gets
  // cancelled). When we DON'T, we can't reload THIS session — but the standby
  // was just refreshed, so a new chat will have the rebuilt list. Either way
  // the agent's recovery action is the same: end the turn, have the user
  // re-send (in this chat if reloaded, in a new chat otherwise).
  if (ctx.sessionId) {
    getSessionManager().scheduleSessionReload(ctx.sessionId);
    return {
      success: true,
      mcpId: input.mcpId,
      message: `Restart scheduled for "${input.mcpId}". The session reload affects all bundled MCPs together (claude-agent-acp doesn't support per-MCP restart yet). End your current response and tell the user: "Restarted ${def.name}. Please re-send your request to use it." Their next message creates a fresh session with the rebuilt MCP list.`,
    };
  }

  serverLogger.warn(
    { tag: "mcp-config", op: "restart_mcp_server", mcpId: input.mcpId, reason: "no_session_id" },
    `restart_mcp_server: no sessionId threaded in _meta — refreshed config + standby only`,
  );
  return {
    success: true,
    mcpId: input.mcpId,
    message: `Config for "${input.mcpId}" refreshed and the standby session was rebuilt, but I couldn't reload THIS chat (no session id was threaded through — a known claude-agent-acp gap). End your current response and tell the user: "Restarted ${def.name}. Please open a NEW chat and re-send your request — the rebuilt MCP list attaches to fresh sessions."`,
  };
}
