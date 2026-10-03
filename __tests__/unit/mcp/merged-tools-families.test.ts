/**
 * The M0 pilot families, through a REAL server and a real MCP client: `libi.caption_style`,
 * `libi.audio_duck`, `libi.job`, `libi.keyframe`, `libi.show`.
 *
 * Each action must behave exactly like the per-verb tool it replaced (the per-function suites —
 * keyframe-tools, audio-duck-tools, job-tools, caption-style-tools, navigation-tools — still hold
 * the handlers to their contracts), and the tool list must carry the merged names only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

let storageRoot: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => {
    const { LocalFileStorage } = await import("@/lib/storage/local");
    return new LocalFileStorage(join(storageRoot, "storage"));
  },
}));

const jobs = vi.hoisted(() => ({
  getJobStatusFromServer: vi.fn(),
  listJobsFromServer: vi.fn(),
  cancelJobOnServer: vi.fn(),
}));
vi.mock("@/mcp/jobs-client", () => ({
  ...jobs,
  LibiServerUnavailableError: class LibiServerUnavailableError extends Error {
    hint = "";
  },
}));

const studio = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/mcp/tools/social-http", () => studio);

import { createLibiMcpServer } from "@/mcp/server";
import { notify } from "@/mcp/notify";
import { MERGED_TOOL_DISCRIMINATORS } from "@/lib/agents/merged-tools";
import { registeredMergedTools } from "@/mcp/tools/action-registry";
import { addOverlay, addKeyframe, listKeyframes } from "@/mcp/tools/overlay-tools";
import { loadManifest } from "@/lib/composition/persistence";

type Surface = "cli" | "in-app";

async function connect(surface: Surface = "in-app") {
  const server = createLibiMcpServer({ surface });
  const client = new Client({ name: "t", version: "0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return {
    tools: async (): Promise<Tool[]> => (await client.listTools()).tools,
    call: async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as Array<{ text: string }>)[0].text;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        // SDK-level refusals are plain text
      }
      return { isError: !!res.isError, text, json };
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "libi-merged-"));
  process.env.LIBI_HOME = storageRoot;
  mkdirSync(join(storageRoot, "storage"), { recursive: true });
  jobs.getJobStatusFromServer.mockReset();
  jobs.listJobsFromServer.mockReset();
  jobs.cancelJobOnServer.mockReset();
  studio.api.mockReset();
});
afterEach(() => {
  rmSync(storageRoot, { recursive: true, force: true });
  delete process.env.LIBI_HOME;
  vi.restoreAllMocks();
});

const OLD_TOOLS = [
  "libi.create_caption_style", "libi.list_caption_styles", "libi.delete_caption_style",
  "libi.audio_duck_enable", "libi.audio_duck_update", "libi.audio_duck_disable",
  "libi.get_job_status", "libi.list_jobs", "libi.cancel_job",
  "libi.list_keyframes", "libi.delete_keyframe", "libi.set_keyframe_easing",
  "libi.show_piece", "libi.show_preview", "libi.show_asset", "libi.show_folder",
  "libi.show_storyboard", "libi.show_templates", "libi.show_extension",
];

describe("the tool list", () => {
  it.each(["cli", "in-app"] as const)("(%s) carries the merged tools and none of the per-verb ones", async (surface) => {
    const h = await connect(surface);
    const names = (await h.tools()).map((t) => t.name);
    for (const merged of Object.keys(MERGED_TOOL_DISCRIMINATORS)) expect(names).toContain(merged);
    for (const old of OLD_TOOLS) expect(names, old).not.toContain(old);
    // the two siblings the spec keeps separate
    expect(names).toContain("libi.add_keyframe");
    expect(names.includes("libi.show_in_chat")).toBe(surface === "in-app");
    await h.close();
  });

  it("MERGED_TOOL_DISCRIMINATORS is exactly what the server registers, discriminator for discriminator", async () => {
    const h = await connect();
    const tools = await h.tools();
    const registered = tools.filter((t) => registeredMergedTools().has(t.name)).map((t) => t.name).sort();
    expect(registered).toEqual(Object.keys(MERGED_TOOL_DISCRIMINATORS).sort());
    for (const t of tools.filter((x) => x.name in MERGED_TOOL_DISCRIMINATORS)) {
      const key = MERGED_TOOL_DISCRIMINATORS[t.name as keyof typeof MERGED_TOOL_DISCRIMINATORS];
      expect(t.inputSchema.required, t.name).toEqual([key]);
      expect(registeredMergedTools().get(t.name)?.discriminator).toBe(key);
      expect((t.inputSchema.properties as Record<string, { enum?: string[] }>)[key].enum, t.name).toEqual(
        [...registeredMergedTools().get(t.name)!.actions],
      );
      // flat: no union keywords anywhere in the advertised schema
      expect(JSON.stringify(t.inputSchema), t.name).not.toMatch(/"(anyOf|oneOf|allOf)"/);
    }
    await h.close();
  });

  it("each family's actions are the ones the spec lists", async () => {
    const actions = (n: string) => [...registeredMergedTools().get(n)!.actions];
    await (await connect()).close();
    expect(actions("libi.caption_style")).toEqual(["create", "list", "delete"]);
    expect(actions("libi.audio_duck")).toEqual(["enable", "update", "disable"]);
    expect(actions("libi.job")).toEqual(["list", "status", "cancel"]);
    expect(actions("libi.keyframe")).toEqual(["list", "delete", "set_easing"]);
    expect(actions("libi.show")).toEqual(["piece", "preview", "asset", "export", "storyboard", "folder", "templates", "extension", "social_settings"]);
  });

  it("descriptions are 1–2 sentences that name the actions, and keyframe points at add_keyframe", async () => {
    const h = await connect();
    const byName = new Map((await h.tools()).map((t) => [t.name, t]));
    for (const [name, key] of Object.entries(MERGED_TOOL_DISCRIMINATORS)) {
      const d = byName.get(name)!.description!;
      expect(d.length, name).toBeLessThan(560);
      for (const a of registeredMergedTools().get(name)!.actions) expect(d, `${name} names ${a}`).toContain(a);
      void key;
    }
    expect(byName.get("libi.keyframe")!.description).toContain("libi.add_keyframe");
    expect(byName.get("libi.keyframe")!.description).toMatch(/ease-out/);
    await h.close();
  });

  it("advertises additionalProperties false and hides the legacy singular `sidechainClipId` / `mcpId`", async () => {
    const h = await connect();
    const byName = new Map((await h.tools()).map((t) => [t.name, t]));
    for (const name of Object.keys(MERGED_TOOL_DISCRIMINATORS)) {
      expect(byName.get(name)!.inputSchema.additionalProperties, name).toBe(false);
    }
    expect(Object.keys(byName.get("libi.audio_duck")!.inputSchema.properties as object)).not.toContain("sidechainClipId");
    expect(Object.keys(byName.get("libi.show")!.inputSchema.properties as object)).not.toContain("mcpId");
    await h.close();
  });

  it("keyframe's advertised input names every action's property, with who uses it and where it is required", async () => {
    const h = await connect();
    const schema = (await h.tools()).find((t) => t.name === "libi.keyframe")!.inputSchema as {
      required: string[];
      properties: Record<string, { description: string; type?: string }>;
    };
    expect(schema.required).toEqual(["action"]);
    expect(Object.keys(schema.properties).sort()).toEqual(["action", "clipId", "easing", "overlayId", "pieceId", "time"]);
    expect(schema.properties.easing.description).toMatch(/^\(set_easing\) .*Required\.$/);
    expect(schema.properties.time.description).toMatch(/^\(delete, set_easing\) /);
    expect(schema.properties.pieceId.description).toMatch(/Required\.$/);
    await h.close();
  });
});

describe("libi.keyframe", () => {
  const pieceId = "p_kf";
  const seed = async () => {
    const add = await addOverlay({
      pieceId, kind: "text", startTime: 0, duration: 4, rect: { x: 10, y: 20, width: 100, height: 50 },
      z: 1, opacity: 1, content: "hello", font: "32px Inter", color: "#ffffff", align: "center",
    } as never);
    const overlayId = (add.data as { overlayId: string }).overlayId;
    await addKeyframe({ pieceId, overlayId, time: 1, properties: { opacity: 0.2 } } as never);
    await addKeyframe({ pieceId, overlayId, time: 3, properties: { opacity: 0.9 } } as never);
    return overlayId;
  };

  it("list returns exactly what the list function returns", async () => {
    const overlayId = await seed();
    const h = await connect();
    const res = await h.call("libi.keyframe", { action: "list", pieceId, overlayId });
    expect(res.json).toEqual(JSON.parse(JSON.stringify(await listKeyframes({ pieceId, overlayId }))));
    expect(res.json.data.times).toEqual([1, 3]);
    await h.close();
  });

  it("set_easing then delete change the manifest, and refresh the composition", async () => {
    const overlayId = await seed();
    const refresh = vi.spyOn(notify, "refreshQuery").mockImplementation(() => {});
    const h = await connect();
    expect((await h.call("libi.keyframe", { action: "set_easing", pieceId, overlayId, time: 1, easing: "ease-out" })).json.success).toBe(true);
    const listed = (await h.call("libi.keyframe", { action: "list", pieceId, overlayId })).json.data;
    expect(listed.tracks.opacity[0]).toMatchObject({ time: 1, easing: "ease-out" });
    expect((await h.call("libi.keyframe", { action: "delete", pieceId, overlayId, time: 1 })).json.success).toBe(true);
    expect((await h.call("libi.keyframe", { action: "list", pieceId, overlayId })).json.data.times).toEqual([3]);
    expect(refresh).toHaveBeenCalledWith({ queryKey: "composition", pieceId });
    expect((await loadManifest(pieceId)).overlays?.length).toBe(1);
    await h.close();
  });

  it("a missing field names the action and what it requires; a field of another action is dropped, as before", async () => {
    const overlayId = await seed();
    const h = await connect();
    const missing = await h.call("libi.keyframe", { action: "set_easing", pieceId, overlayId, time: 1 });
    expect(missing.isError).toBe(true);
    expect(missing.json.error).toContain('libi.keyframe({ action: "set_easing" })');
    expect(missing.json.error).toContain("set_easing requires: pieceId, time, easing");
    // `easing` belongs to set_easing; `delete` strips it (the old delete_keyframe stripped unknown keys)
    const stray = await h.call("libi.keyframe", { action: "delete", pieceId, overlayId, time: 1, easing: "linear" });
    expect(stray.json.success).toBe(true);
    await h.close();
  });
});

describe("libi.audio_duck", () => {
  const PIECE = "p_duck";
  beforeEach(() => {
    mkdirSync(join(storageRoot, "storage", PIECE), { recursive: true });
    writeFileSync(
      join(storageRoot, "storage", PIECE, "composition.json"),
      JSON.stringify({
        width: 1920, height: 1080, fps: 30,
        audioClips: [
          { id: "music", kind: "standalone", fileId: "f-m", startTime: 0, duration: 60, trimStart: 0, volume: 1, enabled: true },
          { id: "vo", kind: "standalone", fileId: "f-vo", startTime: 0, duration: 30, trimStart: 0, volume: 1, enabled: true },
          { id: "vo2", kind: "standalone", fileId: "f-vo2", startTime: 30, duration: 15, trimStart: 0, volume: 1, enabled: true },
        ],
      }),
    );
  });
  const duck = () => JSON.parse(readFileSync(join(storageRoot, "storage", PIECE, "composition.json"), "utf-8")).audioClips[0].duck;

  it("enable → update → disable, with the defaults and the whole-set replace the old tools had", async () => {
    const h = await connect();
    const on = await h.call("libi.audio_duck", { action: "enable", pieceId: PIECE, clipId: "music", sidechainClipIds: ["vo", "vo2"] });
    expect(on.json.success).toBe(true);
    expect(duck()).toMatchObject({ sidechainClipIds: ["vo", "vo2"], thresholdDb: -30, ratio: 4, attackMs: 50, releaseMs: 250, reductionDb: -12 });
    expect((await h.call("libi.audio_duck", { action: "update", pieceId: PIECE, clipId: "music", sidechainClipIds: ["vo"], ratio: 8 })).json.success).toBe(true);
    expect(duck()).toMatchObject({ sidechainClipIds: ["vo"], ratio: 8 });
    expect((await h.call("libi.audio_duck", { action: "disable", pieceId: PIECE, clipId: "music" })).json.success).toBe(true);
    expect(duck()).toBeUndefined();
    await h.close();
  });

  it("still accepts the legacy singular sidechainClipId (not advertised) and enforces the schema's bounds", async () => {
    const h = await connect();
    expect((await h.call("libi.audio_duck", { action: "enable", pieceId: PIECE, clipId: "music", sidechainClipId: "vo" })).json.success).toBe(true);
    expect(duck().sidechainClipIds).toEqual(["vo"]);
    const bad = await h.call("libi.audio_duck", { action: "update", pieceId: PIECE, clipId: "music", ratio: 99 });
    // the advertised schema keeps the original's bounds, so the SDK refuses this one before the action runs
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("ratio");
    await h.close();
  });

  it("the refusal's `accepts:` list never names a hidden legacy field", async () => {
    const h = await connect();
    // `clipId` is required by enable but optional in the flat advertised schema: the action's own schema refuses it
    const res = await h.call("libi.audio_duck", { action: "enable", pieceId: PIECE });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("accepts:");
    expect(res.text).not.toContain("sidechainClipId,");
    expect(res.text).not.toMatch(/accepts:[^"]*sidechainClipId\b(?!s)/);
    await h.close();
  });

  it("update on a clip with no ducking says to enable it first, in the new vocabulary", async () => {
    const h = await connect();
    const res = await h.call("libi.audio_duck", { action: "update", pieceId: PIECE, clipId: "music", ratio: 2 });
    expect(res.json).toMatchObject({ success: false, error: expect.stringContaining('libi.audio_duck({ action: "enable" })') });
    await h.close();
  });
});

describe("libi.job", () => {
  it("list forwards its filters and returns the server's rows", async () => {
    jobs.listJobsFromServer.mockResolvedValue([
      { id: "j1", kind: "export_render", status: "running", pieceId: "p1", progressDone: 1, progressTotal: 4, progressUnit: "frames", etaMs: null, msSinceProgress: 10, startedAt: null, completedAt: null, error: null },
    ]);
    const h = await connect();
    const res = await h.call("libi.job", { action: "list", status: "running", kind: "export_render", limit: 5 });
    expect(jobs.listJobsFromServer).toHaveBeenCalledWith(expect.objectContaining({ status: "running", kind: "export_render", limit: 5 }));
    expect(res.json).toMatchObject({ success: true, data: { count: 1, jobs: [{ jobId: "j1", status: "running", percent: 25 }] } });
    await h.close();
  });

  it("status and cancel take a jobId; without one the error names the action's requirements", async () => {
    jobs.getJobStatusFromServer.mockResolvedValue({ id: "j1", status: "running", resultJson: null });
    jobs.cancelJobOnServer.mockResolvedValue({ jobId: "j1", cancelled: true });
    const h = await connect();
    expect((await h.call("libi.job", { action: "status", jobId: "j1" })).json.success).toBe(true);
    expect(jobs.getJobStatusFromServer).toHaveBeenCalledWith("j1");
    expect((await h.call("libi.job", { action: "cancel", jobId: "j1" })).json.success).toBe(true);
    expect(jobs.cancelJobOnServer).toHaveBeenCalledWith("j1");
    const none = await h.call("libi.job", { action: "status" });
    expect(none.isError).toBe(true);
    expect(none.json.error).toContain("status requires: jobId");
    await h.close();
  });
});

describe("libi.caption_style", () => {
  it("create → list → duplicate refused → delete, with the old error codes", async () => {
    const refresh = vi.spyOn(notify, "refreshQuery").mockImplementation(() => {});
    const h = await connect();
    const made = await h.call("libi.caption_style", { action: "create", name: "My Glow", color: "#ffee00", stroke: { color: "#000", width: 8 } });
    expect(made.json).toMatchObject({ success: true, data: { styleId: "my-glow" } });
    expect(refresh).toHaveBeenCalledWith({ queryKey: "caption-styles" });
    const listed = (await h.call("libi.caption_style", { action: "list" })).json.data.styles as Array<{ id: string }>;
    expect(listed.map((s) => s.id)).toEqual(expect.arrayContaining(["my-glow", "clean"]));
    const again = await h.call("libi.caption_style", { action: "create", name: "My Glow", color: "#fff" });
    expect(again.json).toMatchObject({ success: false, error: "style_name_exists" });
    expect((await h.call("libi.caption_style", { action: "delete", styleId: "my-glow" })).json.success).toBe(true);
    expect(((await h.call("libi.caption_style", { action: "list" })).json.data.styles as Array<{ id: string }>).some((s) => s.id === "my-glow")).toBe(false);
    await h.close();
  });

  it("create without its required fields names them", async () => {
    const h = await connect();
    const res = await h.call("libi.caption_style", { action: "create", name: "No color" });
    expect(res.isError).toBe(true);
    expect(res.json.error).toContain("create requires: name, color");
    await h.close();
  });
});

describe("libi.show target export", () => {
  const exportRow = (over: Record<string, unknown> = {}) => ({ id: "exp_1", name: "final", status: "done", ...over });

  it("opens the Exports tab on that export when the piece and the export exist", async () => {
    studio.api.mockResolvedValue({ ok: true, body: { exports: [exportRow(), exportRow({ id: "exp_2" })] } });
    const nav = vi.spyOn(notify, "navigate").mockImplementation(() => {});
    const h = await connect();
    const res = await h.call("libi.show", { target: "export", pieceId: "p1", exportId: "exp_2" });
    expect(studio.api).toHaveBeenCalledWith("/api/pieces/p1/exports");
    expect(res.json).toMatchObject({ success: true, data: { navigated: true, exportId: "exp_2", pieceId: "p1" } });
    expect(nav).toHaveBeenCalledWith({ target: "exports", pieceId: "p1", id: "exp_2" });
    await h.close();
  });

  it("does NOT navigate for an unknown export, a cancelled one, or a missing piece — and says so", async () => {
    const nav = vi.spyOn(notify, "navigate").mockImplementation(() => {});
    const h = await connect();
    studio.api.mockResolvedValue({ ok: true, body: { exports: [exportRow(), exportRow({ id: "exp_c", status: "cancelled" })] } });
    expect((await h.call("libi.show", { target: "export", pieceId: "p1", exportId: "nope" })).json).toMatchObject({ success: false, error: "export_not_found" });
    expect((await h.call("libi.show", { target: "export", pieceId: "p1", exportId: "exp_c" })).json).toMatchObject({ success: false, error: "export_not_found" });
    studio.api.mockResolvedValue({ ok: false, status: 404, body: {} });
    expect((await h.call("libi.show", { target: "export", pieceId: "gone", exportId: "exp_1" })).json).toMatchObject({ success: false, error: "piece_not_found" });
    studio.api.mockResolvedValue({ ok: false, status: 0, body: { message: "down" } });
    expect((await h.call("libi.show", { target: "export", pieceId: "p1", exportId: "exp_1" })).json).toMatchObject({ success: false, error: "libi_server_unavailable" });
    expect(nav).not.toHaveBeenCalled();
    await h.close();
  });
});

describe("libi.show target social_settings", () => {
  it("opens Social → Settings (at the account when given) and reports whether the studio accepted it", async () => {
    const nav = vi.spyOn(notify, "navigateSocial").mockResolvedValue(true);
    const h = await connect();
    const withAccount = await h.call("libi.show", { target: "social_settings", accountId: "acc-ig" });
    expect(withAccount.json).toMatchObject({ success: true, data: { ok: true, navigated: true } });
    expect(nav).toHaveBeenLastCalledWith({ accountId: "acc-ig" });
    await h.call("libi.show", { target: "social_settings" });
    expect(nav).toHaveBeenLastCalledWith({});
    nav.mockResolvedValue(false);
    expect((await h.call("libi.show", { target: "social_settings" })).json).toMatchObject({ success: true, data: { navigated: false } });
    await h.close();
  });
});
