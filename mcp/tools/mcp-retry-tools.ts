import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { probeMcpServer } from "@/mcp/registry/server-prober";
import { invalidateMcpConfig } from "@/lib/mcp-config";
import { DependencyManager } from "@/mcp/registry/dependency-manager";
import { serverLogger as logger } from "@/lib/logger";
import type { ToolResult } from "./types";
import type { RetryMcpServerParams } from "./schemas";
import { isWindows } from "@/lib/platform";

/**
 * Re-probe an external MCP server and refresh its serverStatus in the DB.
 *
 * Guard cases (returns success: false):
 *  - mcpId not found in DB
 *  - mcpId === "libi" (core server, synthesized in-process — cannot probe)
 *  - installStatus not in { installed, not_required } (deps not ready)
 *
 * On success (status becomes "up"): invalidates the MCP config cache so
 * future sessions pick up the fix. The current ACP session cannot use
 * newly-recovered tools — `recoveredInThisSession` is always false.
 */
export async function retryMcpServer(params: RetryMcpServerParams): Promise<ToolResult> {
  const db = getDb();

  const [row] = db.select().from(mcpServers).where(eq(mcpServers.id, params.mcpId)).limit(1).all();
  if (!row) {
    return { success: false, error: `MCP server '${params.mcpId}' not found.` };
  }

  if (row.id === "libi") {
    return {
      success: false,
      error: "Cannot retry the libi core server — it is synthesized in-process.",
    };
  }

  if (row.installStatus !== "installed" && row.installStatus !== "not_required") {
    return {
      success: false,
      error: `Cannot retry: dependencies not installed (installStatus=${row.installStatus}). Resync dependencies first.`,
    };
  }

  // Mark as "starting" while probe is in-flight
  db.update(mcpServers)
    .set({ serverStatus: "starting", serverLastChecked: new Date(), updatedAt: new Date() })
    .where(eq(mcpServers.id, row.id))
    .run();

  const libiBinDir = DependencyManager.getBinDir();
  const pathSep = isWindows() ? ";" : ":";
  const augmentedPath = `${libiBinDir}${pathSep}${process.env.PATH ?? ""}`;
  const userEnv: Record<string, string> = row.envVars ? JSON.parse(row.envVars) : {};
  const args: string[] = row.args ? JSON.parse(row.args) : [];

  const result = await probeMcpServer({
    command: row.command ?? "",
    args,
    env: { PATH: augmentedPath, ...userEnv },
    timeoutMs: 10_000,
  });

  db.update(mcpServers)
    .set({
      serverStatus: result.status,
      serverError: result.error,
      serverLastChecked: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(mcpServers.id, row.id))
    .run();

  if (result.status === "up") {
    invalidateMcpConfig({ reason: `mcp-retry:${row.id}` });
  }

  logger.info(
    { mcpId: row.id, status: result.status, durationMs: result.durationMs },
    "Retried MCP server",
  );

  return {
    success: true,
    data: {
      mcpId: row.id,
      status: result.status,
      error: result.error,
      recoveredInThisSession: false,
    },
  };
}
