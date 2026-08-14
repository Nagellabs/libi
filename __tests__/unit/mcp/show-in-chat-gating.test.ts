import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Surface-gating proof for `libi.show_in_chat` (inline-chat-media Task 1 GATE).
 *
 * The tool must be registered ONLY when the libi MCP process is spawned for the
 * in-app ACP chat (`LIBI_AGENT_SURFACE === "in-app"`). A terminal / BYO-CLI
 * agent's libi process leaves the flag unset, so the tool is absent from its
 * tool list and the agent cannot call it.
 */
describe("show_in_chat surface gating (registration responds to LIBI_AGENT_SURFACE)", () => {
  const ORIG = process.env.LIBI_AGENT_SURFACE;

  afterEach(() => {
    if (ORIG === undefined) delete process.env.LIBI_AGENT_SURFACE;
    else process.env.LIBI_AGENT_SURFACE = ORIG;
    vi.restoreAllMocks();
  });

  async function registeredToolNames(): Promise<string[]> {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const names: string[] = [];
    // Spy on the prototype so we capture EVERY registration, including the
    // gated one — the analytics/coercion wrappers call through to this.
    vi.spyOn(McpServer.prototype, "registerTool").mockImplementation(function (
      this: unknown,
      name: string,
    ) {
      names.push(name);
      return {} as never;
    });
    const { createLibiMcpServer } = await import("@/mcp/server");
    createLibiMcpServer();
    return names;
  }

  it("registers libi.show_in_chat when surface is in-app", async () => {
    process.env.LIBI_AGENT_SURFACE = "in-app";
    const names = await registeredToolNames();
    expect(names).toContain("libi.show_in_chat");
    // sanity: other always-on tools are present
    expect(names).toContain("libi.show_asset");
  });

  it("does NOT register libi.show_in_chat when the flag is unset (terminal/BYO-CLI)", async () => {
    delete process.env.LIBI_AGENT_SURFACE;
    const names = await registeredToolNames();
    expect(names).not.toContain("libi.show_in_chat");
    expect(names).toContain("libi.show_asset");
  });

  it("does NOT register it for any non-'in-app' value", async () => {
    process.env.LIBI_AGENT_SURFACE = "cli";
    const names = await registeredToolNames();
    expect(names).not.toContain("libi.show_in_chat");
  });
});
