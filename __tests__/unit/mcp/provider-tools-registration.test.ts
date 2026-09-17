import { describe, it, expect, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentSurface } from "@/lib/mcp/agent-surface";
import { createLibiMcpServer } from "@/mcp/server";
import { PROVIDER_CATALOG } from "@/lib/providers/catalog";

/**
 * `libi.suggest_provider` and `libi.list_providers` are registered on BOTH
 * surfaces — unlike `libi.show_in_chat`, which only the in-app chat gets. A
 * CLI agent needs the add commands as text; an in-app agent gets the panel.
 * The branch happens inside the tool (see provider-tools.test.ts), not at
 * registration, so a terminal agent must still see both tools.
 */
describe("provider tools are registered on every surface", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Statically imported, deliberately.
   *
   * These were dynamic `import()`s inside the test body, which put the cost of
   * loading the whole `mcp/server` module graph (every tool module, the DB
   * client, the registry) INSIDE the first case's 5 s budget. Under full-suite
   * load that is what made "surface undefined" fail while it passed standalone
   * and on a re-run — a timeout wearing the costume of a wiring bug. A static
   * import pays that cost once, at collection, where it is not racing a
   * per-test clock. (The prototype spy is not the flake: vitest's default fork
   * pool gives every test FILE its own process and module registry, so it
   * cannot reach another suite.)
   */
  function registeredToolNames(surface?: AgentSurface): string[] {
    const names: string[] = [];
    vi.spyOn(McpServer.prototype, "registerTool").mockImplementation(function (
      this: unknown,
      name: string,
    ) {
      names.push(name);
      return {} as never;
    });
    createLibiMcpServer(surface !== undefined ? { surface } : undefined);
    return names;
  }

  it.each([undefined, "cli", "in-app"] as const)("surface %s", (surface) => {
    const names = registeredToolNames(surface);
    expect(names).toContain("libi.suggest_provider");
    expect(names).toContain("libi.list_providers");
  });

  /**
   * Claude Code keeps MCP tools out of the prompt until a search finds them. Asked "is fal.ai available?", the agent
   * on Windows searched for "fal", found neither provider tool, and answered in prose with no card. Both descriptions
   * therefore name every catalog provider, and suggest_provider's covers a question as well as a generation.
   */
  it("both provider tools' descriptions name every catalog provider, so a search for one finds them", () => {
    const descriptions = new Map<string, string>();
    vi.spyOn(McpServer.prototype, "registerTool").mockImplementation(function (
      this: unknown,
      name: string,
      config: { description?: string },
    ) {
      descriptions.set(name, config.description ?? "");
      return {} as never;
    });
    createLibiMcpServer({ surface: "in-app" });
    for (const tool of ["libi.suggest_provider", "libi.list_providers"]) {
      // The names a user types, fixed here so a catalog-derived string that came out empty still fails.
      for (const name of ["fal.ai", "Higgsfield", "ElevenLabs"]) {
        expect(descriptions.get(tool), `${tool} never names ${name}`).toContain(name);
      }
      for (const def of PROVIDER_CATALOG) {
        expect(descriptions.get(tool), `${tool} never names ${def.name}`).toContain(def.name);
      }
      // A catalog, not a claim about what is connected or installed.
      expect(descriptions.get(tool)).toContain("libi's provider catalog (not necessarily connected or installed)");
    }
    expect(descriptions.get("libi.suggest_provider")).toMatch(/when the user asks about a provider that is not in your tool list/);
    expect(descriptions.get("libi.list_providers")).toMatch(/added after this chat started, so a new chat has it/);
    expect(descriptions.get("libi.list_providers")).toMatch(/connected here for your agent \(its row's `agent`\) with no tools under its `name`/);
    expect(descriptions.get("libi.list_providers")).toMatch(/for a provider the user asks about that is not in your tool list, call libi\.suggest_provider instead/);
  });

  it("the retired tools stay gone", () => {
    const names = registeredToolNames("in-app");
    expect(names).not.toContain("libi.show_api_config");
    expect(names).not.toContain("libi.list_bundled_mcps");
    // Folded into libi.list_providers. Two tools answering overlapping
    // questions is a cost the agent pays on every turn, and this one's
    // description told it to "discover capabilities (e.g. AI image/video/audio
    // MCPs)" in a table that has held only libi's own rows since 0051.
    expect(names).not.toContain("libi.list_mcp_servers");
  });
});
