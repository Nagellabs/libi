import { describe, it, expect } from "vitest";
import { createTrackingMcpServer } from "@/mcp/tracking-mcp/server";
import { createLibiMcpServer } from "@/mcp/server";
import {
  registeredToolNames,
  TRACKING_TOOL_NAMES,
} from "@/__tests__/helpers/mcp-tools";

describe("tracking tool hosting (always-on guarantee)", () => {
  it("libi-tracking MCP registers all tracking tools", () => {
    const names = registeredToolNames(createTrackingMcpServer());
    for (const t of TRACKING_TOOL_NAMES) expect(names).toContain(t);
  });

  // The dogfood failure this guards: claude-agent-acp loads MCP servers at
  // session-creation time, so a separately-spawned tier-2 libi-tracking MCP
  // could race that and leave the agent with ZERO tracking tools. The 13
  // tracking tools are therefore ALSO registered on the always-on core
  // `libi` MCP so the agent can never be missing them.
  it("core libi MCP ALSO registers every tracking tool (always available)", () => {
    const names = registeredToolNames(createLibiMcpServer());
    expect(names.length).toBeGreaterThan(0);
    for (const t of TRACKING_TOOL_NAMES) expect(names).toContain(t);
  });

  // Single shared registerTrackingTools() → the two surfaces can never
  // drift. Every tracking tool on the standalone MCP must also be on core.
  it("core libi and libi-tracking expose the identical tracking surface", () => {
    const core = new Set(registeredToolNames(createLibiMcpServer()));
    const standalone = registeredToolNames(createTrackingMcpServer());
    for (const t of standalone) {
      if (t.startsWith("libi.") && TRACKING_TOOL_NAMES.includes(t as never)) {
        expect(core.has(t)).toBe(true);
      }
    }
  });
});
