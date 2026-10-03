/**
 * Legacy tool inputs: still ACCEPTED, no longer ADVERTISED (T §"Deprecated /
 * legacy", Q3). Old skills and transcripts keep working; the model stops
 * paying for fields that mean nothing.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v3";
import { createLibiMcpServer } from "@/mcp/server";
import { LEGACY_INPUT_FIELDS } from "@/mcp/tools/legacy-inputs";
import {
  AddTrackedOverlaySchema,
  UpdateTrackedOverlaySchema,
  VerifyTrackedOverlayShape,
  audioAddClipSchema,
  audioDuckEnableSchema,
  audioDuckUpdateSchema,
  exportVideoSchema,
  getInstallPlanSchema,
  listEffectsSchema,
  musicDownloadModelSchema,
  publishTemplateSchema,
  resolveExtensionId,
  showExtensionSchema,
  VerifyInstallSchema,
} from "@/mcp/tools/schemas";

async function listTools(): Promise<Tool[]> {
  const server = createLibiMcpServer({ surface: "in-app" });
  const client = new Client({ name: "t", version: "0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

/** The zod schema behind each tool in LEGACY_INPUT_FIELDS, as the SDK validates it. */
const SCHEMAS: Record<string, z.ZodTypeAny> = {
  "libi.export_video": z.object(exportVideoSchema),
  "libi.publish_template": publishTemplateSchema,
  "libi.audio_add_clip": audioAddClipSchema,
  // merged tools: the schema of the action that still accepts the legacy field
  "libi.audio_duck": audioDuckEnableSchema,
  "libi.music_download_model": musicDownloadModelSchema,
  "libi.show": showExtensionSchema,
  "libi.get_install_plan": getInstallPlanSchema,
  "libi.verify_install": VerifyInstallSchema,
};

/** A value of the right type for each legacy field, plus what else the schema needs to parse. */
const SAMPLE_INPUT: Record<string, Record<string, unknown>> = {
  "libi.export_video": { pieceId: "p", destFolder: "/Users/me/Desktop" },
  "libi.publish_template": { templateId: "t", exampleVideo: { fileId: "f" }, confirm: true },
  "libi.audio_add_clip": { pieceId: "p", fileId: "f", startTime: 0, kind: "inline", linkedSceneId: "scene-1" },
  "libi.audio_duck": { pieceId: "p", clipId: "c", sidechainClipId: "vo" },
  "libi.music_download_model": { forceNew: true },
  "libi.show": { mcpId: "libi-tracking" },
  "libi.get_install_plan": { extensionId: "whisper" },
  "libi.verify_install": { extensionId: "libi-tracking" },
};

describe("LEGACY_INPUT_FIELDS", () => {
  it("covers every entry with a schema and a sample, so nothing here can go stale unseen", () => {
    expect(Object.keys(SCHEMAS).sort()).toEqual(Object.keys(LEGACY_INPUT_FIELDS).sort());
    expect(Object.keys(SAMPLE_INPUT).sort()).toEqual(Object.keys(LEGACY_INPUT_FIELDS).sort());
  });

  it.each(Object.entries(LEGACY_INPUT_FIELDS))("%s: %j is not advertised", async (name, fields) => {
    const tool = (await listTools()).find((t) => t.name === name);
    expect(tool, `${name} is not registered`).toBeTruthy();
    const props = Object.keys((tool!.inputSchema.properties ?? {}) as object);
    const required = (tool!.inputSchema.required ?? []) as string[];
    for (const f of fields) {
      expect(props, `${name}.${f} is still advertised`).not.toContain(f);
      expect(required).not.toContain(f);
    }
    // ...and the tool is not left with an empty schema (the SDK's silent failure mode).
    expect(props.length + (name === "libi.music_download_model" ? 1 : 0)).toBeGreaterThan(0);
  });

  it.each(Object.entries(LEGACY_INPUT_FIELDS))("%s: the old input still parses and the legacy key survives", (name, fields) => {
    const parsed = SCHEMAS[name].safeParse(SAMPLE_INPUT[name]);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    for (const f of fields) {
      expect(parsed.success && f in (parsed.data as object), `${name}.${f} was stripped by the schema`).toBe(true);
    }
  });
});

describe("alias inputs still work", () => {
  it("show target extension: mcpId alone, extensionId alone, and both resolve (extensionId wins)", () => {
    expect(resolveExtensionId(showExtensionSchema.parse({ mcpId: "whisper" }))).toBe("whisper");
    expect(resolveExtensionId(showExtensionSchema.parse({ extensionId: "local-music" }))).toBe("local-music");
    expect(resolveExtensionId(showExtensionSchema.parse({ extensionId: "a", mcpId: "b" }))).toBe("a");
  });

  it("get_install_plan / verify_install: extensionId resolves as mcpId", () => {
    expect(resolveExtensionId(getInstallPlanSchema.parse({ extensionId: "whisper" }))).toBe("whisper");
    expect(resolveExtensionId(getInstallPlanSchema.parse({ mcpId: "whisper" }))).toBe("whisper");
    expect(resolveExtensionId(VerifyInstallSchema.parse({ extensionId: "libi-tracking" }))).toBe("libi-tracking");
  });

  it("audio_duck (enable and update): the singular sidechainClipId is kept for the handler to normalize", () => {
    expect(audioDuckEnableSchema.parse({ pieceId: "p", clipId: "c", sidechainClipId: "vo" }).sidechainClipId).toBe("vo");
    expect(audioDuckUpdateSchema.parse({ pieceId: "p", clipId: "c", sidechainClipId: "vo" }).sidechainClipId).toBe("vo");
  });

  it("music_download_model: forceNew is kept (the handler treats it as force)", () => {
    expect(musicDownloadModelSchema.parse({ forceNew: true }).forceNew).toBe(true);
  });
});

describe("a merged tool still accepts its hidden legacy field end to end", () => {
  it("libi.audio_duck update with the singular sidechainClipId reaches the handler (and is not advertised)", async () => {
    const server = createLibiMcpServer({ surface: "in-app" });
    const client = new Client({ name: "t", version: "0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      // the clip does not exist: reaching "Clip … not found" proves the legacy key got through validation
      const res = await client.callTool({
        name: "libi.audio_duck",
        arguments: { action: "update", pieceId: "p", clipId: "c", sidechainClipId: "vo" },
      });
      const text = (res.content as Array<{ type: string; text: string }>)[0].text;
      expect(res.isError).toBeFalsy();
      expect(JSON.parse(text)).toMatchObject({ success: false, error: expect.stringContaining("not found") });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("export_video.destFolder is still REFUSED over MCP, not stripped", () => {
  it("a real tools/call with destFolder reaches the handler and is refused", async () => {
    const server = createLibiMcpServer({ surface: "in-app" });
    const client = new Client({ name: "t", version: "0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      const res = await client.callTool({ name: "libi.export_video", arguments: { pieceId: "p", destFolder: "/Users/me/Desktop" } });
      const text = (res.content as Array<{ type: string; text: string }>)[0].text;
      expect(JSON.parse(text)).toMatchObject({ success: false, data: { error: "dest_folder_removed" } });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("the same for the variants path", async () => {
    const server = createLibiMcpServer({ surface: "in-app" });
    const client = new Client({ name: "t", version: "0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      const res = await client.callTool({
        name: "libi.export_video",
        arguments: { pieceId: "p", destFolder: "/tmp", variants: [{ format: "mp4" }] },
      });
      const text = (res.content as Array<{ type: string; text: string }>)[0].text;
      expect(JSON.parse(text)).toMatchObject({ success: false, data: { error: "dest_folder_removed" } });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("legacy VALUES", () => {
  it("smoothing: 'kalman' is accepted and becomes 'linear' on every tracked-overlay schema", () => {
    const add = { pieceId: "p", fileId: "f", trackId: "t", startTime: 0, duration: 1, rect: { x: 0, y: 0, width: 1, height: 1 }, z: 1, opacity: 1, content: { kind: "emoji", char: "x" }, fit: "tight", scale: 1 };
    const base = AddTrackedOverlaySchema.safeParse({ ...add, smoothing: "kalman" });
    expect(base).toMatchObject({ success: true, data: { smoothing: "linear" } });
    expect(UpdateTrackedOverlaySchema.safeParse({ pieceId: "p", overlayId: "o", smoothing: "kalman" })).toMatchObject({ success: true, data: { smoothing: "linear" } });
    expect(z.object(VerifyTrackedOverlayShape).safeParse({ smoothing: "kalman" })).toMatchObject({ success: true, data: { smoothing: "linear" } });
    expect(z.object(VerifyTrackedOverlayShape).safeParse({ smoothing: "catmull-rom" })).toMatchObject({ success: true, data: { smoothing: "catmull-rom" } });
    expect(z.object(VerifyTrackedOverlayShape).safeParse({ smoothing: "bogus" }).success).toBe(false);
    expect(z.object(VerifyTrackedOverlayShape).safeParse({}).success).toBe(true);
  });

  it("smoothing: tools/list advertises linear | catmull-rom only on libi.tracked_overlay (add requires it, per its description)", async () => {
    const tools = await listTools();
    const t = tools.find((x) => x.name === "libi.tracked_overlay")!;
    const prop = (t.inputSchema.properties as Record<string, { enum?: string[]; description?: string }>).smoothing;
    expect(prop.enum).toEqual(["linear", "catmull-rom"]);
    expect(prop.description).toBeTruthy();
    expect(prop.description).not.toMatch(/kalman/);
    expect(prop.description).toMatch(/Required for add/);
  });

  it("effect list: kind 'scene' (a layer kind nothing resolves to any more) still parses, as 'video'", async () => {
    expect(listEffectsSchema.parse({ kind: "scene" }).kind).toBe("video");
    expect(listEffectsSchema.parse({ kind: "text" }).kind).toBe("text");
    expect(listEffectsSchema.parse({}).kind).toBeUndefined();
    expect(listEffectsSchema.safeParse({ kind: "bogus" }).success).toBe(false);
    const t = (await listTools()).find((x) => x.name === "libi.effect")!;
    const kind = (t.inputSchema.properties as Record<string, { enum?: string[] }>).kind;
    expect(kind.enum).toEqual(["text", "image", "video", "code", "three", "tracked", "audio"]);
  });
});
