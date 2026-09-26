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
  "libi.update_template",
  "libi.list_templates",
  "libi.search_templates",
  "libi.get_template",
  "libi.apply_template",
  "libi.delete_template",
  "libi.show_templates",
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
  it("apply_template's converted schema carries the documented arguments", async () => {
    const tool = (await listTools()).tools.find((t) => t.name === "libi.apply_template")!;
    expect(Object.keys((tool.inputSchema.properties ?? {}) as object).sort()).toEqual([
      "cloudId",
      "confirmReplace",
      "copy",
      "mode",
      "newPiece",
      "pieceId",
      "slotValues",
      "templateId",
    ]);
  });

  it("publish_template's converted schema carries the documented arguments, and its description says it only prepares — the user publishes", async () => {
    const tool = (await listTools()).tools.find((t) => t.name === "libi.publish_template")!;
    expect(Object.keys((tool.inputSchema.properties ?? {}) as object).sort()).toEqual(["confirm", "exampleVideo", "nickname", "templateId"]);
    // `confirm` is still accepted (older skill copies send it) but no longer required.
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
  it("apply_template and get_template frame index.md as untrusted author content", async () => {
    const tools = (await listTools()).tools;
    for (const name of ["libi.apply_template", "libi.get_template"]) {
      const d = tools.find((t) => t.name === name)!.description ?? "";
      expect(d, name).not.toMatch(/follow its Steps/);
      expect(d, name).toMatch(/untrusted/i);
      for (const never of ["shell command", "fetch a URL", "files", "secrets", "other pieces"]) expect(d, `${name}: ${never}`).toContain(never);
      expect(d, name).toMatch(/ask the user/);
    }
  });
});
