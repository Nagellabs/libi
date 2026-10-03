/**
 * `/api/e2e/run-tool` validates a tool's arguments exactly as libi's MCP
 * endpoint does for an agent's call — same schema, same coercion, same refusal.
 *
 * It used to call the tool FUNCTION with the raw body. A seed missing a
 * required field was not refused but persisted (`startTime`/`duration` as
 * `undefined` on a video overlay — never a base video, and a Timeline crash),
 * a misnamed field was silently dropped, and eight Playwright specs rotted
 * behind seeds no agent could have made (docs-local/qa/2026-09-26-e2e-fixes-report.md).
 *
 * The refusal text is asserted against a REAL MCP client talking to a REAL
 * `createLibiMcpServer()`, so the two cannot drift apart silently; and the
 * route's schema table is checked against the tools the server advertises.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const { addOverlay, trimVideo, listTemplatesTool, deleteTemplateTool, applyLayerEffect, addEffectTool, removeEffectTool } = vi.hoisted(() => {
  type Handler = (params: Record<string, unknown>) => Promise<{ success: boolean; data: unknown }>;
  return {
    addOverlay: vi.fn<Handler>(async () => ({ success: true, data: { overlayId: "vid-1" } })),
    trimVideo: vi.fn<Handler>(async () => ({ success: true, data: { fileId: "f2" } })),
    listTemplatesTool: vi.fn<Handler>(async () => ({ success: true, data: { templates: [] } })),
    deleteTemplateTool: vi.fn<Handler>(async () => ({ success: true, data: { deleted: true } })),
    applyLayerEffect: vi.fn<Handler>(async () => ({ success: true, data: { applied: true } })),
    addEffectTool: vi.fn<Handler>(async () => ({ success: true, data: { id: "e2e-shift" } })),
    removeEffectTool: vi.fn<Handler>(async () => ({ success: true, data: {} })),
  };
});
vi.mock("@/mcp/tools/effect-package-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools/effect-package-tools")>()),
  addEffectTool,
  removeEffectTool,
}));
vi.mock("@/mcp/tools/effect-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools/effect-tools")>()),
  applyLayerEffect,
}));
vi.mock("@/mcp/tools/template-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools/template-tools")>()),
  listTemplatesTool,
  deleteTemplateTool,
}));
vi.mock("@/mcp/tools/overlay-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools/overlay-tools")>()),
  addOverlay,
}));
vi.mock("@/mcp/tools/ffmpeg-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools/ffmpeg-tools")>()),
  trimVideo,
}));
const gate = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/lib/security/test-routes", () => ({ testRoutesEnabled: () => gate.enabled }));
vi.mock("@/mcp/notify", () => ({ notify: { refreshQuery: vi.fn() } }));

import { POST } from "@/app/api/e2e/run-tool/route";
import { notify } from "@/mcp/notify";
import { createLibiMcpServer } from "@/mcp/server";
import { installToolsListShaping } from "@/mcp/tools-list-shape";
import { coerceInputSchema, installArgCoercion } from "@/mcp/tools/coerce-args";
import { RUN_TOOL_INPUT_SCHEMAS, parseErrorMessage, toObjectSchema } from "@/lib/e2e/run-tool-input";
// The SDK's own helpers, which lib/e2e/run-tool-input.ts vendors (they are not a
// documented entry point). Imported HERE only, to hold the copy to them: an SDK
// bump that moves the file fails this test, never the route's build.
import {
  normalizeObjectSchema,
  safeParseAsync,
  getParseErrorMessage,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";

async function runTool(tool: string, args: Record<string, unknown>) {
  const res = await POST(
    new Request("http://127.0.0.1/api/e2e/run-tool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, args }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function withClient<T>(server: McpServer, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

/** What an agent's call with these args gets back from libi's MCP endpoint. */
async function viaMcp(name: string, args: Record<string, unknown>) {
  const res = (await withClient(createLibiMcpServer(), (c) => c.callTool({ name, arguments: args }))) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  return res;
}

const VIDEO = { pieceId: "p1", kind: "video", fileId: "f1", displayName: "base" };

beforeEach(() => {
  gate.enabled = true;
  addOverlay.mockClear();
  trimVideo.mockClear();
  listTemplatesTool.mockClear();
  deleteTemplateTool.mockClear();
  applyLayerEffect.mockClear();
  addEffectTool.mockClear();
  removeEffectTool.mockClear();
});

describe("/api/e2e/run-tool refuses bad arguments the way the MCP endpoint does", () => {
  it("a video overlay without startTime/duration is refused, with the agent's exact refusal, and nothing is written", async () => {
    const { status, body } = await runTool("libi.add_overlay", VIDEO);
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.isError).toBe(true);
    const text = (body.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toMatch(/^MCP error -32602: Input validation error: Invalid arguments for tool libi\.add_overlay: /);
    expect(text).toContain("startTime");
    expect(body.error).toBe(text);
    expect(addOverlay).not.toHaveBeenCalled();

    const agent = await viaMcp("libi.add_overlay", VIDEO);
    expect(agent.isError).toBe(true);
    expect(body.content).toEqual(agent.content);
  });

  it("an unknown field is refused with the strict schema's hint, as for an agent", async () => {
    const args = { ...VIDEO, startTime: 0, duration: 1, name: "base" };
    const { status, body } = await runTool("libi.add_overlay", args);
    expect(status).toBe(400);
    const text = (body.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("`name`");
    expect(text).toContain("displayName");
    expect(addOverlay).not.toHaveBeenCalled();
    expect(body.content).toEqual((await viaMcp("libi.add_overlay", args)).content);
  });

  it("a good call reaches the tool with the PARSED args — defaults applied, JSON-string numbers coerced — like the agent's", async () => {
    const { status, body } = await runTool("libi.add_overlay", { ...VIDEO, startTime: 0, duration: "1.5" });
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, data: { overlayId: "vid-1" } });
    expect(addOverlay).toHaveBeenCalledTimes(1);
    const passed = addOverlay.mock.calls[0][0];
    expect(passed.duration).toBe(1.5); // coerce-args: "1.5" → 1.5
    expect(passed.z).toBe(0); // overlayBase default
    expect(passed.opacity).toBe(1); // overlayBase default
  });

  it("validates tools registered from a raw shape too (trim_video)", async () => {
    const bad = await runTool("libi.trim_video", { pieceId: "p1", fileId: "f1" });
    expect(bad.status).toBe(400);
    expect(trimVideo).not.toHaveBeenCalled();
    expect(bad.body.content).toEqual((await viaMcp("libi.trim_video", { pieceId: "p1", fileId: "f1" })).content);

    const good = await runTool("libi.trim_video", { pieceId: "p1", fileId: "f1", startSeconds: 0, endSeconds: 0.5 });
    expect(good.status).toBe(200);
    expect(trimVideo).toHaveBeenCalledTimes(1);
  });

  it("with test routes off it is a 403 before anything is parsed, validated or run", async () => {
    gate.enabled = false;
    const good = await runTool("libi.add_overlay", { ...VIDEO, startTime: 0, duration: 1 });
    expect(good.status).toBe(403);
    const bad = await runTool("libi.add_overlay", VIDEO);
    expect(bad.status).toBe(403);
    expect(bad.body).not.toHaveProperty("content");
    const notJson = await POST(new Request("http://127.0.0.1/api/e2e/run-tool", { method: "POST", body: "{" }));
    expect(notJson.status).toBe(403);
    expect(addOverlay).not.toHaveBeenCalled();
  });

  it("a merged tool runs the family's own action: libi.template list / delete", async () => {
    const list = await runTool("libi.template", { action: "list" });
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ success: true, data: { templates: [] } });
    expect(listTemplatesTool).toHaveBeenCalledWith({});

    const del = await runTool("libi.template", { action: "delete", templateId: "t1" });
    expect(del.status).toBe(200);
    expect(deleteTemplateTool).toHaveBeenCalledWith({ templateId: "t1" });
  });

  it("libi.layer_effect (what e2e/overlay-sandbox drives) runs the family's apply action with the parsed args", async () => {
    const apply = await runTool("libi.layer_effect", { action: "apply", pieceId: "p", layerId: "o", phase: "loop", effectId: "e2e-shift" });
    expect(apply.status).toBe(200);
    expect(apply.body).toEqual({ success: true, data: { applied: true } });
    expect(applyLayerEffect).toHaveBeenCalledWith({ pieceId: "p", layerId: "o", phase: "loop", effectId: "e2e-shift" });
    const bad = await runTool("libi.layer_effect", { action: "apply", pieceId: "p", layerId: "o", phase: "sideways", effectId: "x" });
    expect(bad.status).toBe(400);
    expect(applyLayerEffect).toHaveBeenCalledOnce();
    // the per-verb name is gone
    expect((await runTool("libi.apply_layer_effect", {})).status).toBe(404);
  });

  it("libi.effect (add / remove, what e2e/overlay-sandbox seeds) runs the family's action and sends its own effects-custom refresh", async () => {
    const args = { id: "e2e-shift", name: "E2E shift", family: "animation", phases: ["loop"], supports: ["text"], source: "return { dx: 1 };" };
    const add = await runTool("libi.effect", { action: "add", ...args });
    expect(add.status).toBe(200);
    expect(add.body).toEqual({ success: true, data: { id: "e2e-shift" } });
    expect(addEffectTool).toHaveBeenCalledWith(args);
    expect(notify.refreshQuery).toHaveBeenCalledWith({ queryKey: "effects-custom" });
    const bad = await runTool("libi.effect", { action: "add", id: "x" });
    expect(bad.status).toBe(400);
    expect(addEffectTool).toHaveBeenCalledOnce();
    expect((await runTool("libi.effect", { action: "remove", id: "e2e-shift" })).status).toBe(200);
    expect(removeEffectTool).toHaveBeenCalledWith({ id: "e2e-shift" });
    // the per-verb names are gone
    expect((await runTool("libi.add_effect", args)).status).toBe(404);
  });

  it("a merged tool refuses a missing or unknown action, and a bad argument for the action, before anything runs", async () => {
    const none = await runTool("libi.template", { templateId: "t1" });
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/needs `action`: one of list, delete\./);

    const unknown = await runTool("libi.template", { action: "publish", templateId: "t1" });
    expect(unknown.status).toBe(400);

    // a REAL action of the tool that no spec drives is not exposed either
    const notExposed = await runTool("libi.template", { action: "update", templateId: "t1" });
    expect(notExposed.status).toBe(400);
    expect(notExposed.body.error).toMatch(/one of list, delete\./);
    const clone = await runTool("libi.effect", { action: "install_from_git", url: "https://example.com/x.git" });
    expect(clone.status).toBe(400);
    expect(clone.body.error).toMatch(/one of add, remove\./);

    const bad = await runTool("libi.template", { action: "delete" });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toContain('action: "delete"');
    expect(String(bad.body.error)).toContain("templateId");
    expect(deleteTemplateTool).not.toHaveBeenCalled();
  });

  it("an unknown tool is still a 404", async () => {
    const { status } = await runTool("libi.add_text_overlay", {});
    expect(status).toBe(404);
  });
});

describe("the route's schema table is the MCP endpoint's", () => {
  it("every tool it dispatches advertises the same input schema on createLibiMcpServer()", async () => {
    const real = await withClient(createLibiMcpServer(), (c) => c.listTools());
    const mirror = new McpServer({ name: "mirror", version: "0" });
    installArgCoercion(mirror);
    // registerTool's overloads don't take a union of schema forms; call it structurally.
    const register = mirror.registerTool.bind(mirror) as unknown as (
      name: string,
      config: { inputSchema: unknown },
      cb: () => Promise<unknown>,
    ) => void;
    for (const [name, schema] of Object.entries(RUN_TOOL_INPUT_SCHEMAS)) {
      register(name, { inputSchema: schema }, async () => ({ content: [] }));
    }
    // The real server's tools/list is shaped (no $schema, legacy fields hidden); the mirror must be too.
    installToolsListShaping(mirror);
    const ours = await withClient(mirror, (c) => c.listTools());
    const byName = new Map(real.tools.map((t) => [t.name, t.inputSchema]));
    expect(ours.tools.length).toBe(Object.keys(RUN_TOOL_INPUT_SCHEMAS).length);
    for (const t of ours.tools) {
      expect(byName.has(t.name), `${t.name} is not registered on the MCP server`).toBe(true);
      expect(t.inputSchema, t.name).toEqual(byName.get(t.name));
    }
  });
});

describe("the vendored SDK helpers match the SDK's own", () => {
  const samples: Array<[string, Record<string, unknown>]> = [
    ["libi.add_overlay", VIDEO],
    ["libi.add_overlay", { ...VIDEO, startTime: 0, duration: 1, name: "x" }],
    ["libi.add_overlay", { ...VIDEO, startTime: "0", duration: "1.5" }],
    ["libi.trim_video", { pieceId: "p1", fileId: "f1" }],
    ["libi.trim_video", { pieceId: "p1", fileId: "f1", startSeconds: 0, endSeconds: 1 }],
    ["libi.get_piece_state", {}],
    ["libi.publish_template", { templateId: 7 }],
  ];

  it.each(samples)("%s %j: same object schema, same parse, same wording", async (tool, args) => {
    const schema = coerceInputSchema(RUN_TOOL_INPUT_SCHEMAS[tool as keyof typeof RUN_TOOL_INPUT_SCHEMAS]);
    const ours = toObjectSchema(schema)!;
    const theirs = normalizeObjectSchema(schema as never)!;
    expect(ours).toBeDefined();
    expect(Object.keys(ours.shape)).toEqual(Object.keys((theirs as unknown as { shape: object }).shape));

    const a = await ours.safeParseAsync(args);
    const b = await safeParseAsync(theirs, args);
    expect(a.success).toBe(b.success);
    if (a.success && b.success) expect(a.data).toEqual(b.data);
    if (!a.success && !b.success) expect(parseErrorMessage(a.error)).toBe(getParseErrorMessage(b.error));
  });

  it("the non-schema cases answer as the SDK's do", () => {
    for (const v of [undefined, null, "x", 3, {}]) {
      expect(toObjectSchema(v)).toBe(normalizeObjectSchema(v as never));
    }
    for (const e of [new Error("boom"), { issues: [{ message: "first" }] }, { other: 1 }, "plain"]) {
      expect(parseErrorMessage(e)).toBe(getParseErrorMessage(e));
    }
  });
});
