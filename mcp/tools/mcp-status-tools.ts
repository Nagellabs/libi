import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import { notify } from "@/mcp/notify";
import type { ToolResult } from "./types";
import type { ListBundledMcpsParams, ShowMcpSettingsParams } from "./schemas";
import type { DependencyStatus } from "@/mcp/registry/types";

interface BundledMcpStatus {
  id: string;
  name: string;
  description: string;
  installStatus: string;
  enabled: boolean;
  requiredEnvVars: string[];
  configuredEnvVars: string[];
  installError: string | null;
  serverStatus: string;
  serverError: string | null;
  serverLastChecked: number | null;
  /** Per-dep live status (runtimeStatus, progress, error). Empty when no deps or row is fresh. */
  dependencies: DependencyStatus[];
}

/**
 * List the status of every bundled MCP server. NEVER returns env var values —
 * only names. Used by the agent to detect needs_config / failed states and
 * direct the user to Settings.
 */
export async function listBundledMcps(_params: ListBundledMcpsParams): Promise<ToolResult> {
  const db = getDb();
  const rows = db.select().from(mcpServers).where(eq(mcpServers.bundled, true)).all();

  const mcps: BundledMcpStatus[] = rows.map((row) => {
    const def = BUNDLED_MCP_SERVERS.find((d) => d.id === row.id);
    let configured: string[] = [];
    if (row.envVars) {
      try {
        const parsed = JSON.parse(row.envVars) as Record<string, string>;
        configured = Object.keys(parsed).filter((k) => parsed[k] !== undefined && parsed[k] !== "");
      } catch {
        // Malformed JSON — treat as nothing configured.
      }
    }
    let dependencies: DependencyStatus[] = [];
    if (row.dependencyStatus) {
      try {
        const parsed = JSON.parse(row.dependencyStatus);
        if (Array.isArray(parsed)) dependencies = parsed as DependencyStatus[];
      } catch {
        // Malformed JSON — return empty so the agent/UI sees a stable shape.
      }
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? "",
      installStatus: row.installStatus,
      enabled: row.enabled,
      requiredEnvVars: def?.requiredEnvVars ?? [],
      configuredEnvVars: configured,
      installError: row.installError ?? null,
      serverStatus: row.serverStatus,
      serverError: row.serverError ?? null,
      serverLastChecked: row.serverLastChecked
        ? Math.floor(row.serverLastChecked.getTime() / 1000)
        : null,
      dependencies,
    };
  });

  return { success: true, data: { mcps } };
}

/**
 * Navigate the user to the MCPs & Skills page (MCP tab), optionally focused
 * on a bundled MCP card. Fire-and-forget — the SSE event is delivered
 * asynchronously to the UI.
 */
export async function showMcpSettings(params: ShowMcpSettingsParams): Promise<ToolResult> {
  notify.navigateSettings({ mcpId: params.mcpId });
  return { success: true, data: { ok: true, navigated: true } };
}
