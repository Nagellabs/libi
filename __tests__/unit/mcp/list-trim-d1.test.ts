/**
 * D1: the tools/list trims that must not lose behaviour — the loosely advertised nested schemas still validate in
 * full on the server, the shape pass drops only what clients read past, and every job-backed tool keeps its one
 * sentence about an interrupted call.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createLibiMcpServer } from "@/mcp/server";
import { compactSchema } from "@/mcp/tools-list-shape";
import { uploadFileSchema } from "@/mcp/tools/schemas";

async function open() {
  const server = createLibiMcpServer({ surface: "in-app" });
  const client = new Client({ name: "t", version: "0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return {
    tools: async (): Promise<Tool[]> => (await client.listTools()).tools,
    call: async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args });
      return { isError: !!res.isError, text: (res.content as Array<{ text: string }>)[0].text };
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("compactSchema", () => {
  it("drops nested additionalProperties:false and minLength:1, keeps the root's and every property named like them", () => {
    const out = compactSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        minLength: { type: "string", minLength: 1 },
        rect: {
          type: "object",
          additionalProperties: false,
          properties: { x: { type: "number" } },
          required: ["x"],
        },
        extra: { type: "object", additionalProperties: { type: "string", minLength: 2 } },
      },
    });
    expect(out).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        minLength: { type: "string" },
        rect: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
        extra: { type: "object", additionalProperties: { type: "string", minLength: 2 } },
      },
    });
  });
});

describe("loosely advertised nested schemas still validate in full", () => {
  it("libi.upload_file advertises aiGeneration as an open object, and refuses a malformed one before touching the file", async () => {
    const h = await open();
    const tool = (await h.tools()).find((t) => t.name === "libi.upload_file")!;
    const ai = (tool.inputSchema.properties as Record<string, { type?: string; properties?: object }>).aiGeneration;
    expect(ai.type).toBe("object");
    expect(ai.properties).toBeUndefined();
    const res = await h.call("libi.upload_file", { pieceId: "p", filePath: "/nope/x.mp4", aiGeneration: { provider: "fal" } });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/aiGeneration/);
    await h.close();
  });

  it("the full upload schema still accepts the documented provenance block", () => {
    const parsed = uploadFileSchema.safeParse({
      pieceId: "p",
      filePath: "/a/b.mp4",
      aiGeneration: {
        provider: "fal",
        model: "veo3.1-fast",
        prompt: "a prompt",
        startedAt: "2026-10-02T10:00:00.000Z",
        completedAt: "2026-10-02T10:01:00.000Z",
        durationMs: 60000,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("libi.model_schema_cache advertises `fields` as untyped objects with the GenFieldDef shape in its text", async () => {
    const h = await open();
    const tool = (await h.tools()).find((t) => t.name === "libi.model_schema_cache")!;
    const fields = (tool.inputSchema.properties as Record<string, { items?: { properties?: object }; description?: string }>).fields;
    expect(fields.items?.properties).toBeUndefined();
    expect(fields.description).toMatch(/GenFieldDef\[\]/);
    expect(fields.description).toMatch(/text\|number\|boolean\|url\|enum/);
    await h.close();
  });
});

describe("tools that advertise a looser schema than they validate refuse a bad call before doing anything", () => {
  type Props = Record<string, { type?: string; items?: { type?: string; properties?: object }; properties?: object; description?: string }>;
  const props = (tools: Tool[], name: string) => tools.find((t) => t.name === name)!.inputSchema.properties as Props;

  it("libi.export_video: `variants` is an array of open objects; a bad entry is refused naming it", async () => {
    const h = await open();
    const v = props(await h.tools(), "libi.export_video").variants;
    expect(v.items?.properties).toBeUndefined();
    expect(v.description).toMatch(/customWidth, customHeight/);
    const res = await h.call("libi.export_video", { pieceId: "p", variants: [{ format: "gif" }] });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/variants\.0\.format/);
    await h.close();
  });

  it("libi.publish_template: exampleVideo is an open object naming the three sources; two sources at once are refused", async () => {
    const h = await open();
    const ex = props(await h.tools(), "libi.publish_template").exampleVideo;
    expect(ex.type).toBe("object");
    expect(ex.description).toMatch(/\{ fileId \}.*\{ path \}.*\{ exportPieceId \}/);
    const res = await h.call("libi.publish_template", { templateId: "t", exampleVideo: { fileId: "a", path: "/b.mp4" } });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/exampleVideo/);
    await h.close();
  });

  it("libi.add_keyframe: rect and transform3d are open objects; a malformed rect is refused", async () => {
    const h = await open();
    const properties = props(await h.tools(), "libi.add_keyframe").properties as unknown as { properties: Props };
    expect(properties.properties.rect.properties).toBeUndefined();
    expect(properties.properties.opacity.type).toBe("number");
    const res = await h.call("libi.add_keyframe", { pieceId: "p", overlayId: "o", time: 1, properties: { rect: { x: "left" } } });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/properties\.rect/);
    await h.close();
  });

  it("libi.add_storyboard_card: blocks and render are open; a bad block is refused. edit_storyboard_card: a bad camera shot is refused", async () => {
    const h = await open();
    const tools = await h.tools();
    const card = props(tools, "libi.add_storyboard_card").card as unknown as { properties: Props };
    expect(card.properties.blocks.items?.properties).toBeUndefined();
    expect(card.properties.render.properties).toBeUndefined();
    expect(card.properties.camera).toBeDefined();
    const bad = await h.call("libi.add_storyboard_card", { pieceId: "p", card: { title: "t", blocks: [{ id: "b" }] } });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/card\.blocks/);
    expect(props(tools, "libi.edit_storyboard_card").fields.properties).toBeUndefined();
    const edit = await h.call("libi.edit_storyboard_card", { pieceId: "p", cardId: "c", fields: { camera: { shot: "dutch" } } });
    expect(edit.isError).toBe(true);
    expect(edit.text).toMatch(/fields\.camera\.shot/);
    await h.close();
  });

  it("the merged tools' open fields are validated by their action: catalog fromAsset, track samples, analysis words", async () => {
    const h = await open();
    const tools = await h.tools();
    expect(props(tools, "libi.character").fromAsset.properties).toBeUndefined();
    expect(props(tools, "libi.catalog_item").fromAsset.properties).toBeUndefined();
    expect(props(tools, "libi.track").samples.items?.properties).toBeUndefined();
    expect(props(tools, "libi.analysis_save").words.items?.properties).toBeUndefined();
    const res = await h.call("libi.character", { action: "create", name: "Ann", fromAsset: { fileId: "f" } });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/fromAsset/);
    await h.close();
  });
});

describe("the advertised list carries no nested strictness noise", () => {
  it("only the root object of a tool says additionalProperties:false", async () => {
    const h = await open();
    for (const t of await h.tools()) {
      const nested = JSON.stringify({ ...t.inputSchema, additionalProperties: undefined });
      expect(nested, t.name).not.toContain('"additionalProperties":false');
      expect(nested, t.name).not.toContain('"minLength":1');
    }
    await h.close();
  });
});
