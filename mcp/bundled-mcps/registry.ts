import type { BundledMcpDef } from "@/mcp/registry/types";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";

/**
 * Tier-2 bundled MCPs — installed by the agent on demand, not by
 * libi's Category A install. Derived from the combined registry so the
 * single source of truth stays in `mcp/registry/bundled.ts`.
 *
 * **Adding a new bundled MCP?** See `mcp/bundled-mcps/README.md`.
 */
export const BUNDLED_MCPS: BundledMcpDef[] = BUNDLED_MCP_SERVERS.filter(
  (def) => def.installFlow === "tier-2",
);
