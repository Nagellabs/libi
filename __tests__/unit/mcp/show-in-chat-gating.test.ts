import { describe, it, expect, vi, afterEach } from "vitest";
import { IN_APP_ONLY_TOOLS, type AgentSurface } from "@/lib/mcp/agent-surface";

/**
 * Surface-gating proof for `libi.show_in_chat` (inline-chat-media Task 1 GATE).
 *
 * The tool must be registered ONLY when `createLibiMcpServer` is called with
 * `{ surface: "in-app" }` — the surface an HTTP server derives from the
 * `x-libi-surface` request header. A terminal / BYO-CLI agent's request never
 * carries that header, so its libi process registers with `cli` (or no
 * option at all) and the tool is absent from its tool list.
 */
async function registeredToolNames(surface?: AgentSurface): Promise<string[]> {
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
  createLibiMcpServer(surface !== undefined ? { surface } : undefined);
  return names;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("show_in_chat surface gating (registration responds to createLibiMcpServer's surface option)", () => {

  it("registers libi.show_in_chat when surface is in-app", async () => {
    const names = await registeredToolNames("in-app");
    expect(names).toContain("libi.show_in_chat");
    // sanity: other always-on tools are present
    expect(names).toContain("libi.show_asset");
  });

  it("does NOT register libi.show_in_chat when no surface is passed (terminal/BYO-CLI default)", async () => {
    const names = await registeredToolNames();
    expect(names).not.toContain("libi.show_in_chat");
    expect(names).toContain("libi.show_asset");
  });

  it("does NOT register it for any non-'in-app' value", async () => {
    const names = await registeredToolNames("cli");
    expect(names).not.toContain("libi.show_in_chat");
  });
});

/**
 * Drift guard for `IN_APP_ONLY_TOOLS` (lib/mcp/agent-surface.ts).
 *
 * That list is not documentation: the HTTP aggregator reads it to turn a call
 * to an in-app-only tool on a `cli` session into a logged, actionable error
 * instead of a bare "unknown tool". Since libi's ACP entry took back the name
 * `libi connect` writes, that call is also the TRIPWIRE for the in-app entry
 * having failed to replace the config one — the one path by which an in-app
 * agent can end up holding only the headerless registration.
 *
 * So a tool gated behind `if (opts.surface === "in-app")` without being listed
 * fails here, rather than silently losing its loud error.
 */
describe("IN_APP_ONLY_TOOLS matches what the in-app surface actually adds", () => {
  it("equals the exact difference between the two surfaces' registrations", async () => {
    const inApp = await registeredToolNames("in-app");
    vi.restoreAllMocks();
    const cli = await registeredToolNames("cli");
    const onlyInApp = inApp.filter((n) => !cli.includes(n)).sort();
    expect(onlyInApp).toEqual([...IN_APP_ONLY_TOOLS].sort());
    // Sanity: the cli surface never gains a tool the in-app one lacks.
    expect(cli.filter((n) => !inApp.includes(n))).toEqual([]);
  });
});
