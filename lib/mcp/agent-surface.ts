/**
 * Agent surface gating — the single source of truth for restricting an MCP
 * tool to the runtime "surface" the agent is running on.
 *
 * Libi delivers its MCP to two kinds of agent:
 *  - **in-app** — the ACP chat (`newSession({ mcpServers })`). Can render rich
 *    UI (inline media cards, etc.).
 *  - **cli** — a terminal / BYO-CLI agent (discovers libi via the workspace
 *    `.mcp.json` / `.claude/settings.local.json`). Text-only; no app chat to
 *    render into.
 *
 * The surface is carried to the libi MCP **process** via the `LIBI_AGENT_SURFACE`
 * env var, which is injected onto the libi server entry **only on the in-app
 * (ACP) delivery channel** (see `lib/mcp-config.ts#getMcpServersForAcp`). The
 * `.mcp.json`/settings channel never sets it, so a terminal agent's libi
 * process reports `cli` and any in-app-only tools are simply not registered —
 * the agent never sees them and cannot call them.
 *
 * To gate a NEW tool to the in-app chat:
 *   import { isInAppSurface } from "@/lib/mcp/agent-surface";
 *   if (isInAppSurface()) server.registerTool("libi.my_tool", …);
 *
 * Verified end-to-end (real MCP tools/list, server spawned per surface):
 * the in-app spawn lists the gated tool; the terminal spawn does not.
 */

export type AgentSurface = "in-app" | "cli";

/** Env var carrying the surface to the libi MCP process. */
export const AGENT_SURFACE_ENV = "LIBI_AGENT_SURFACE";

export const IN_APP_SURFACE: AgentSurface = "in-app";
export const CLI_SURFACE: AgentSurface = "cli";

/**
 * The surface of the current process. Defaults to `cli` when the flag is unset
 * — the conservative default, so an in-app-only tool never leaks to a terminal
 * agent (whose channel never sets the flag).
 */
export function currentAgentSurface(): AgentSurface {
  return process.env[AGENT_SURFACE_ENV] === IN_APP_SURFACE
    ? IN_APP_SURFACE
    : CLI_SURFACE;
}

/** True when this libi MCP process serves the in-app ACP chat. */
export function isInAppSurface(): boolean {
  return currentAgentSurface() === IN_APP_SURFACE;
}

/**
 * The env entry that marks an MCP server entry as the in-app surface. Injected
 * onto the libi entry on the ACP delivery channel only. Returned in the
 * `{ name, value }` shape the ACP `newSession` mcpServers list uses.
 */
export function inAppSurfaceEnvEntry(): { name: string; value: string } {
  return { name: AGENT_SURFACE_ENV, value: IN_APP_SURFACE };
}
