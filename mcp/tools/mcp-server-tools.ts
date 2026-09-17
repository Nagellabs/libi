import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { notify } from "@/mcp/notify";
import { mcpLogger as logger } from "@/lib/logger";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import { eq } from "drizzle-orm";
import type { ToolResult } from "./types";
import type { UpdateMcpServerParams } from "./schemas";

/**
 * PATCH a libi-owned MCP row. The table holds only libi's own
 * rows, so the only editable field left is `requireApproval` (the extension
 * approval gate, enforced in `decidePermissionAction`). Everything else —
 * name, command, args, url, headers, envVars — is either derived from the
 * bundled def or, for provider keys, something libi never stores.
 */
export async function updateMcpServer(params: UpdateMcpServerParams): Promise<ToolResult> {
  const db = getDb();
  const row = db.select().from(mcpServers).where(eq(mcpServers.id, params.id)).get();
  if (!row) {
    return { success: false, error: "not_found", data: { id: params.id } };
  }
  const def = BUNDLED_MCP_SERVERS.find((d) => d.id === params.id);
  if (def?.kind === "core") {
    return {
      success: false,
      error: "read-only",
      data: { message: "the libi core row cannot be edited" },
    };
  }
  const extra = Object.keys(params).filter((k) => k !== "id" && k !== "requireApproval");
  if (extra.length > 0) {
    return {
      success: false,
      error: "read-only",
      data: { message: `only requireApproval is editable; rejected: ${extra.join(", ")}` },
    };
  }
  if (params.requireApproval === undefined) {
    return { success: false, error: "no_change", data: { message: "pass requireApproval" } };
  }

  logger.info(
    { tag: "mcp-server-tools", op: "update", id: params.id, requireApproval: params.requireApproval },
    "updating mcp server approval gate",
  );

  db.update(mcpServers)
    .set({ requireApproval: params.requireApproval, updatedAt: new Date() })
    .where(eq(mcpServers.id, params.id))
    .run();

  notify.refreshMcpConfig();

  return { success: true, data: { id: params.id, requireApproval: params.requireApproval } };
}
