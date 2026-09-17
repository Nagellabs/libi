import { describe, it, expect } from "vitest";
import { buildExtensionsSection } from "@/mcp/registry/instruction-builder";
import { EXTENSION_MCP_SERVERS } from "@/mcp/registry/bundled";
import type { McpServerRecord } from "@/lib/db/schema/types";

function makeMcpRow(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    id: "test-mcp",
    name: "Test MCP",
    description: "A test MCP server",
    npmUrl: null,
    type: "stdio",
    command: "npx",
    args: '["test-mcp"]',
    url: null,
    headers: null,
    envVars: null,
    requireApproval: false,
    bundled: false,
    installStatus: "installed",
    installError: null,
    dependencyStatus: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// An extension with no agentInstructions of its own, so the section's only
// reason to mention it is the approval contract.
const silent = EXTENSION_MCP_SERVERS.find((d) => !d.agentInstructions);
// An extension that ships its own guidance.
const guided = EXTENSION_MCP_SERVERS.find((d) => d.agentInstructions);

describe("buildExtensionsSection", () => {
  it("emits nothing when there are no rows", () => {
    expect(buildExtensionsSection([])).toBe("");
  });

  it("ignores rows that are not libi extensions (third-party MCPs are never described)", () => {
    const result = buildExtensionsSection([makeMcpRow({ requireApproval: true })]);
    expect(result).toBe("");
  });

  it("emits nothing for an extension that needs no approval and has no guidance", () => {
    expect(silent, "fixture: an extension without agentInstructions").toBeDefined();
    const result = buildExtensionsSection([
      makeMcpRow({ id: silent!.id, name: silent!.name, bundled: true, requireApproval: false }),
    ]);
    expect(result).toBe("");
  });

  it("emits the REQUIRES APPROVAL line naming the tool prefixes when the row requires approval", () => {
    expect(silent).toBeDefined();
    const result = buildExtensionsSection([
      makeMcpRow({ id: silent!.id, name: silent!.name, bundled: true, requireApproval: true }),
    ]);
    expect(result).toContain("## libi extensions");
    expect(result).toContain(`**${silent!.name}**`);
    expect(result).toContain("REQUIRES APPROVAL");
    for (const prefix of silent!.toolPrefixes) expect(result).toContain(prefix);
  });

  it("emits agentInstructions verbatim", () => {
    expect(guided, "fixture: an extension with agentInstructions").toBeDefined();
    const result = buildExtensionsSection([
      makeMcpRow({ id: guided!.id, name: guided!.name, bundled: true, requireApproval: false }),
    ]);
    expect(result).toContain(guided!.agentInstructions!);
    expect(result).not.toContain("REQUIRES APPROVAL");
  });

  it("never describes availability — install state does not change the output", () => {
    expect(guided).toBeDefined();
    const installed = buildExtensionsSection([
      makeMcpRow({ id: guided!.id, name: guided!.name, bundled: true, installStatus: "installed" }),
    ]);
    const pending = buildExtensionsSection([
      makeMcpRow({ id: guided!.id, name: guided!.name, bundled: true, installStatus: "pending" }),
    ]);
    expect(pending).toBe(installed);
    expect(installed).not.toContain("unavailable due to installation issues");
    expect(installed).not.toContain("Installation pending");
  });
});
