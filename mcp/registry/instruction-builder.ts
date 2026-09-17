import type { McpServerRecord } from "@/lib/db/schema/types";
import { EXTENSION_MCP_SERVERS } from "./bundled";

/**
 * Build the "libi extensions" markdown section for agent instructions.
 *
 * Extensions are libi's own on-device capabilities. Their tools are ALWAYS
 * listed on the core server and answer `needs_install` before install, so this
 * section never describes availability — it carries only the approval contract
 * and each extension's own guidance. Third-party MCPs are not described at all:
 * the agent sees them in its live tool list, and libi does not manage them.
 */
export function buildExtensionsSection(mcpRows: McpServerRecord[]): string {
  const byId = new Map(mcpRows.map((r) => [r.id, r]));
  const lines: string[] = [];

  for (const def of EXTENSION_MCP_SERVERS) {
    const row = byId.get(def.id);
    if (!row) continue;
    if (!row.requireApproval && !def.agentInstructions) continue;
    if (lines.length === 0) lines.push("\n## libi extensions\n");
    lines.push(`- **${def.name}**: ${def.description}`);
    if (row.requireApproval) {
      lines.push(
        `  REQUIRES APPROVAL — before calling any of ${def.toolPrefixes.join(", ")}, describe what you are about to do and wait for explicit confirmation.`,
      );
    }
    if (def.agentInstructions) lines.push(`  ${def.agentInstructions}`);
  }

  if (lines.length === 0) return "";
  lines.push("");
  return lines.join("\n");
}
