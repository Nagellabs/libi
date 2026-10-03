/**
 * The template tools reach an agent only if they survive the SDK's
 * JSON-schema conversion — which under zod v4 fails SILENTLY and drops every
 * tool from `tools/list`. Asserted through a REAL `tools/list`, like
 * `social-tools-registration.test.ts`.
 *
 * They are registered on BOTH surfaces: a user's own Claude Code or Codex
 * captures, applies and publishes templates in its own project, so none of
 * them belongs in `IN_APP_ONLY_TOOLS`.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLibiMcpServer } from "@/mcp/server";
import { IN_APP_ONLY_TOOLS } from "@/lib/mcp/agent-surface";
import type { AgentSurface } from "@/lib/mcp/agent-surface";

const NAMES = [
  "libi.create_template_from_piece",
  "libi.template",
  "libi.apply_template",
  "libi.fetch_template_music",
  "libi.show",
  "libi.publish_template",
] as const;

async function listTools(surface?: AgentSurface) {
  const server = createLibiMcpServer(surface !== undefined ? { surface } : undefined);
  const client = new Client({ name: "test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return await client.listTools();
  } finally {
    await client.close();
    await server.close();
  }
}

describe("the template tools are reachable over MCP on both surfaces", () => {
  it.each([undefined, "cli", "in-app"] as const)("surface %s", async (surface) => {
    const names = (await listTools(surface)).tools.map((t) => t.name);
    expect(names).toContain("libi.add_overlay");
    for (const n of NAMES) expect(names).toContain(n);
  });
  it("none is in-app-only", () => {
    for (const n of NAMES) expect(IN_APP_ONLY_TOOLS).not.toContain(n);
  });
  it("libi.template is one flat tool whose actions are the five readers/admin verbs; none of the other template tools is folded into it", async () => {
    const tools = (await listTools()).tools;
    const tool = tools.find((t) => t.name === "libi.template")!;
    const props = (tool.inputSchema.properties ?? {}) as Record<string, { enum?: string[] }>;
    expect(props.action.enum).toEqual(["get", "search", "list", "update", "delete"]);
    expect(tool.inputSchema.required).toEqual(["action"]);
    const names = tools.map((t) => t.name);
    for (const old of ["libi.get_template", "libi.search_templates", "libi.list_templates", "libi.update_template", "libi.delete_template"]) {
      expect(names, old).not.toContain(old);
    }
    for (const kept of ["libi.create_template_from_piece", "libi.apply_template", "libi.fetch_template_music", "libi.publish_template"]) {
      expect(names, kept).toContain(kept);
    }
  });

  it("apply_template's converted schema carries the documented arguments", async () => {
    const tool = (await listTools()).tools.find((t) => t.name === "libi.apply_template")!;
    expect(Object.keys((tool.inputSchema.properties ?? {}) as object).sort()).toEqual([
      "cloudId",
      "confirmReplace",
      "copy",
      "fit",
      "layerOverrides",
      "mode",
      "navigate",
      "newPiece",
      "omitLayers",
      "pieceId",
      "slotValues",
      "startAt",
      "templateId",
    ]);
  });

  it("publish_template's converted schema carries the documented arguments, and its description says it only prepares — the user publishes", async () => {
    const tool = (await listTools()).tools.find((t) => t.name === "libi.publish_template")!;
    // `confirm` is still accepted (older skill copies send it) but is neither advertised nor required.
    expect(Object.keys((tool.inputSchema.properties ?? {}) as object).sort()).toEqual(["exampleVideo", "nickname", "templateId"]);
    expect([...(tool.inputSchema.required ?? [])].sort()).toEqual(["exampleVideo", "templateId"]);
    const d = tool.description ?? "";
    expect(d).toMatch(/PUBLIC catalog/);
    expect(d).toMatch(/no private cloud option/);
    expect(d).toMatch(/this tool never publishes/);
    expect(d).toMatch(/only the user can publish it, from libi's Templates page/);
    expect(d).toMatch(/awaiting_your_confirmation/);
    expect(d).toMatch(/never say it is published/);
    expect(d).toMatch(/ask the user whether to keep the template private or make it public/);
  });

  // Final review I3: these descriptions are the one instruction EVERY client
  // sees — a user's own Claude Code or Codex never has to load the skill — and
  // apply_template's used to say "follow its Steps" with no caveat.
  it("apply_template and libi.template get frame index.md as untrusted author content", async () => {
    const tools = (await listTools()).tools;
    // The `get` action's rule rides in the `action` property's description, which every client renders.
    const actionDoc = (tools.find((t) => t.name === "libi.template")!.inputSchema.properties as Record<string, { description?: string }>).action
      .description!;
    const getAction = actionDoc.slice(actionDoc.indexOf("get = "), actionDoc.indexOf("; search = "));
    const texts: Array<[string, string]> = [
      ["libi.apply_template", tools.find((t) => t.name === "libi.apply_template")!.description ?? ""],
      ["libi.template get", getAction],
    ];
    for (const [name, d] of texts) {
      expect(d, name).not.toMatch(/follow its Steps/);
      expect(d, name).toMatch(/untrusted/i);
      for (const never of ["shell command", "fetch a URL", "files", "secrets", "other pieces"]) expect(d, `${name}: ${never}`).toContain(never);
      expect(d, name).toMatch(/ask the user/);
    }
  });
});
