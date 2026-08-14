import type { McpServerRecord } from "@/lib/db/schema/types";
import { BUNDLED_MCP_SERVERS } from "./bundled";

/**
 * Build the "External Tools" markdown section for agent instructions.
 * Returns empty string if no external MCPs are relevant.
 */
export function buildExternalToolsSection(mcpRows: McpServerRecord[]): string {
  const enabled = mcpRows.filter((r) => r.enabled);
  if (enabled.length === 0) return "";

  const available = enabled.filter(
    (r) => r.installStatus === "installed" || r.installStatus === "not_required"
  );
  const unavailable = enabled.filter(
    (r) => r.installStatus === "failed" || r.installStatus === "pending" || r.installStatus === "checking"
  );

  if (available.length === 0 && unavailable.length === 0) return "";

  const lines: string[] = ["\n## External Tools\n"];

  if (available.length > 0) {
    lines.push(
      "The following external MCP servers are connected to this session. " +
      "Their tools appear in your tool list alongside the built-in `libi.*` tools — " +
      "call them directly like any other tool.\n"
    );
    for (const row of available) {
      lines.push(`- **${row.name}**: ${row.description ?? "No description."}`);
      if (row.requireApproval) {
        lines.push(
          `  REQUIRES APPROVAL — Before calling any ${row.name} tool, you MUST describe the action to the user and wait for explicit confirmation.`
        );
      }
      const bundled = BUNDLED_MCP_SERVERS.find((b) => b.id === row.id);
      if (bundled?.agentInstructions) {
        lines.push(`  ${bundled.agentInstructions}`);
      }
    }
    lines.push("");
  }

  if (unavailable.length > 0) {
    lines.push("The following MCP servers are currently unavailable due to installation issues:\n");
    for (const row of unavailable) {
      const reason = row.installError ?? "Installation pending";
      lines.push(`- **${row.name}**: ${reason}`);
      const bundled = BUNDLED_MCP_SERVERS.find((b) => b.id === row.id);
      if (bundled?.installPlanPath) {
        lines.push(
          `  This is an optional extended engine you can install on demand: call \`libi.get_install_plan({ id: "${row.id}" })\` to get the step-by-step install guide, then follow it.`
        );
      } else {
        lines.push(
          `  If the user asks to use ${row.name}, explain that it is not currently available and suggest they check the MCP Servers settings page.`
        );
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
