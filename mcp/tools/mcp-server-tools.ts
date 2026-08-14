import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { notify } from "@/mcp/notify";
import { mcpLogger as logger } from "@/lib/logger";
import { eq } from "drizzle-orm";
import type { ToolResult } from "./types";
import type {
  RegisterMcpServerParams,
  UpdateMcpServerParams,
  SetMcpServerEnabledParams,
  RemoveMcpServerParams,
} from "./schemas";

/**
 * Register a new external MCP server.
 * Writes to DB and notifies the Next.js server to update agent settings
 * so the new server is available in the next session.
 */
export async function registerMcpServer(
  params: RegisterMcpServerParams
): Promise<ToolResult> {
  const { name, type, command, args, url, headers, envVars, description, requireApproval } = params;

  if (type === "stdio" && !command) {
    return { success: false, error: "command is required for stdio type" };
  }
  if (type === "http" && !url) {
    return { success: false, error: "url is required for http type" };
  }

  const db = getDb();
  const [row] = db
    .insert(mcpServers)
    .values({
      name,
      description: description ?? null,
      type,
      command: command ?? null,
      args: args ? JSON.stringify(args) : null,
      url: url ?? null,
      headers: headers ? JSON.stringify(headers) : null,
      envVars: envVars ? JSON.stringify(envVars) : null,
      requireApproval: requireApproval ?? true,
      bundled: false,
      installStatus: "not_required",
    })
    .returning()
    .all();

  notify.refreshMcpConfig();

  return {
    success: true,
    data: {
      id: row.id,
      name: row.name,
      type: row.type,
      enabled: row.enabled,
      requireApproval: row.requireApproval,
      message: "MCP server registered. It will be available in the next agent session.",
    },
  };
}

const BUNDLED_EDITABLE_FIELDS = ["envVars", "requireApproval"] as const;

/**
 * Update an existing MCP server's config (PATCH semantics).
 * Never allows editing `type` or `bundled`. Bundled rows accept only
 * `envVars` and `requireApproval`; all other edits are rejected.
 */
export async function updateMcpServer(
  params: UpdateMcpServerParams
): Promise<ToolResult> {
  const { id, name, description, command, args, url, headers, envVars, requireApproval } = params;

  const db = getDb();
  const [row] = db.select().from(mcpServers).where(eq(mcpServers.id, id)).all();
  if (!row) {
    return { success: false, error: "mcp server not found", data: { id } };
  }

  const providedRestrictedFields: string[] = [];
  if (name !== undefined) providedRestrictedFields.push("name");
  if (description !== undefined) providedRestrictedFields.push("description");
  if (command !== undefined) providedRestrictedFields.push("command");
  if (args !== undefined) providedRestrictedFields.push("args");
  if (url !== undefined) providedRestrictedFields.push("url");
  if (headers !== undefined) providedRestrictedFields.push("headers");

  if (row.bundled && providedRestrictedFields.length > 0) {
    return {
      success: false,
      error: "bundled MCP fields are read-only",
      data: {
        id,
        rejectedFields: providedRestrictedFields,
        editableFields: [...BUNDLED_EDITABLE_FIELDS],
      },
    };
  }

  const patch: Partial<typeof mcpServers.$inferInsert> = {};
  if (name !== undefined) patch.name = name;
  if (description !== undefined) patch.description = description;
  if (command !== undefined) patch.command = command;
  if (args !== undefined) patch.args = JSON.stringify(args);
  if (url !== undefined) patch.url = url;
  if (headers !== undefined) patch.headers = JSON.stringify(headers);
  if (envVars !== undefined) patch.envVars = JSON.stringify(envVars);
  if (requireApproval !== undefined) patch.requireApproval = requireApproval;

  if (Object.keys(patch).length === 0) {
    return {
      success: true,
      data: {
        id: row.id,
        name: row.name,
        type: row.type,
        enabled: row.enabled,
        requireApproval: row.requireApproval,
        message: "No fields to update.",
      },
    };
  }

  logger.info(
    {
      tag: "mcp-server-tools",
      op: "update",
      id,
      bundled: row.bundled,
      fields: Object.keys(patch),
      envKeys: envVars ? Object.keys(envVars) : undefined,
    },
    "updating mcp server",
  );

  patch.updatedAt = new Date();

  const [updated] = db
    .update(mcpServers)
    .set(patch)
    .where(eq(mcpServers.id, id))
    .returning()
    .all();

  notify.refreshMcpConfig();

  return {
    success: true,
    data: {
      id: updated.id,
      name: updated.name,
      type: updated.type,
      enabled: updated.enabled,
      requireApproval: updated.requireApproval,
      message: "MCP server updated. Changes take effect in the next agent session.",
    },
  };
}

/**
 * Toggle the `enabled` flag on an MCP server (bundled or custom).
 * Disabled rows are not surfaced to agents but their config is preserved.
 */
export async function setMcpServerEnabled(
  params: SetMcpServerEnabledParams
): Promise<ToolResult> {
  const { id, enabled } = params;

  const db = getDb();
  const [row] = db.select().from(mcpServers).where(eq(mcpServers.id, id)).all();
  if (!row) {
    return { success: false, error: "mcp server not found", data: { id } };
  }

  logger.info(
    { tag: "mcp-server-tools", op: "set_enabled", id, bundled: row.bundled, enabled },
    "toggling mcp server enabled flag",
  );

  const [updated] = db
    .update(mcpServers)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(mcpServers.id, id))
    .returning()
    .all();

  notify.refreshMcpConfig();

  return {
    success: true,
    data: { id: updated.id, name: updated.name, enabled: updated.enabled },
  };
}

/**
 * Permanently delete a custom MCP server row. Bundled servers can never
 * be deleted — disable them via `setMcpServerEnabled` instead.
 */
export async function removeMcpServer(
  params: RemoveMcpServerParams
): Promise<ToolResult> {
  const { id } = params;

  const db = getDb();
  const [row] = db.select().from(mcpServers).where(eq(mcpServers.id, id)).all();
  if (!row) {
    return { success: false, error: "mcp server not found", data: { id } };
  }

  if (row.bundled) {
    return {
      success: false,
      error: "cannot delete bundled MCP; use libi.set_mcp_server_enabled to disable",
      data: { id: row.id, name: row.name },
    };
  }

  logger.info(
    { tag: "mcp-server-tools", op: "remove", id, name: row.name },
    "removing custom mcp server",
  );

  db.delete(mcpServers).where(eq(mcpServers.id, id)).run();

  notify.refreshMcpConfig();

  return {
    success: true,
    data: { id: row.id, name: row.name, message: "MCP server removed." },
  };
}
