import { describe, it, expect } from "vitest";
import {
  registeredToolNames,
  TRACKING_TOOL_NAMES,
} from "@/__tests__/helpers/mcp-tools";
import { registerTrackingTools } from "@/mcp/tracking-mcp/register-tracking-tools";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

describe("identity-disambiguation tools registration", () => {
  it("registers libi.list_identity_candidates and libi.pick_candidate", () => {
    // Build a minimal McpServer-shaped fake that records registerTool names.
    // Mirror the registeredToolNames helper in __tests__/helpers/mcp-tools.ts
    // which reads _registeredTools off a real McpServer. Here we fake that
    // internal map so the same helper can inspect it.
    const _registeredTools: Record<string, unknown> = {};
    const fakeServer = {
      registerTool: (name: string, _meta: unknown, _handler: unknown) => {
        _registeredTools[name] = true;
      },
      _registeredTools,
    } as unknown as McpServer;

    registerTrackingTools(fakeServer);

    const names = Object.keys(_registeredTools);
    expect(names).toContain("libi.list_identity_candidates");
    expect(names).toContain("libi.pick_candidate");
  });

  it("new tools are included in the registeredToolNames helper output", () => {
    const _registeredTools: Record<string, unknown> = {};
    const fakeServer = {
      registerTool: (name: string, _meta: unknown, _handler: unknown) => {
        _registeredTools[name] = true;
      },
      _registeredTools,
    } as unknown as McpServer;

    registerTrackingTools(fakeServer);
    const names = registeredToolNames(fakeServer);

    expect(names).toContain("libi.list_identity_candidates");
    expect(names).toContain("libi.pick_candidate");
  });
});
