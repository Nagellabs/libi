import { writeSettingsFile } from "@/lib/mcp-config";
import { syncCodexGlobalMcpsIfConnected } from "@/lib/codex-config/sync";
import { serverLogger as logger } from "@/lib/logger";

/**
 * Write all agent config files to the workspace directory.
 * Called on startup and whenever MCP server config changes.
 */
export function writeAllAgentConfigs(workspaceDir: string): void {
  writeSettingsFile(workspaceDir);
  void syncCodexGlobalMcpsIfConnected().catch((err) => {
    logger.warn({ err, tag: "codex-config", op: "error" }, "syncCodexGlobalMcpsIfConnected rejected");
  });
}
