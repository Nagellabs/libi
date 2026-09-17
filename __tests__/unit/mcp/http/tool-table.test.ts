import { describe, it, expect } from "vitest";
import { buildToolTable } from "@/mcp/http/tool-table";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const t = (name: string, description = name): Tool => ({ name, description, inputSchema: { type: "object", properties: {} } });

describe("buildToolTable", () => {
  it("passes names, descriptions and schemas through verbatim", () => {
    const schema = { type: "object" as const, properties: { prompt: { type: "string" } }, required: ["prompt"] };
    const tools: Tool[] = [t("libi.list_pieces"), { name: "libi.read_manual", inputSchema: schema }];
    const table = buildToolTable("libi", tools);
    expect(table.tools).toBe(tools);
    expect(table.tools.map((x) => x.name)).toEqual(["libi.list_pieces", "libi.read_manual"]);
    expect(table.tools[1].inputSchema).toBe(schema);
  });

  it("routes every tool to the one source under its own name", () => {
    const table = buildToolTable("libi", [t("libi.list_pieces"), t("libi.read_manual")]);
    expect(table.routes.size).toBe(2);
    expect(table.routes.get("libi.list_pieces")).toEqual({ source: "libi", upstreamName: "libi.list_pieces" });
    expect(table.routes.get("libi.read_manual")).toEqual({ source: "libi", upstreamName: "libi.read_manual" });
  });

  // There is nothing to rename against any more — libi proxies no third-party
  // MCP — so a duplicate is a registration bug in mcp/server.ts, surfaced
  // loudly instead of silently advertising a name twice.
  it("throws on a duplicate name rather than renaming it", () => {
    expect(() => buildToolTable("libi", [t("search"), t("search", "again")])).toThrow(/duplicate tool name/);
  });
});
