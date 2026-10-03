/**
 * The M3 merged families, through a REAL server and a real MCP client. Each action must call the handler
 * the per-verb tool called, with the same (parsed) arguments, send its result back unchanged and do the
 * same `notify.refreshQuery`; the handlers themselves are held to their contracts by their own suites.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const ok = (data: Record<string, unknown> = {}) => ({ success: true as const, data });

const folders = vi.hoisted(() => ({
  createFolderTool: vi.fn(),
  renameFolderTool: vi.fn(),
  moveFolderTool: vi.fn(),
  movePieceToFolderTool: vi.fn(),
  deleteFolderTool: vi.fn(),
  listFoldersTool: vi.fn(),
}));
vi.mock("@/mcp/tools/folder-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools/folder-tools")>()),
  ...folders,
}));
const dup = vi.hoisted(() => ({ duplicateFolderTool: vi.fn() }));
vi.mock("@/mcp/tools/duplication-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools/duplication-tools")>()),
  ...dup,
}));
const assetFolders = vi.hoisted(() => ({
  createAssetFolderTool: vi.fn(),
  renameAssetFolderTool: vi.fn(),
  deleteAssetFolderTool: vi.fn(),
  moveAssetFolderTool: vi.fn(),
  moveAssetTool: vi.fn(),
  assetFolderPieceId: vi.fn(),
  filePieceId: vi.fn(),
}));
vi.mock("@/mcp/tools/asset-folder-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools/asset-folder-tools")>()),
  ...assetFolders,
}));

const clips = vi.hoisted(() => ({ splitClipTool: vi.fn(), deleteClipTool: vi.fn(), duplicateClipTool: vi.fn(), insertTimeTool: vi.fn() }));
vi.mock("@/mcp/tools/clip-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools/clip-tools")>()),
  ...clips,
}));
const audio = vi.hoisted(() => ({
  audioUpdateClip: vi.fn(),
  audioRemoveClip: vi.fn(),
  audioSplit: vi.fn(),
  audioUnlink: vi.fn(),
  audioRelinkOverlay: vi.fn(),
}));
vi.mock("@/mcp/tools/audio-clip-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools/audio-clip-tools")>()),
  ...audio,
}));

const sb = vi.hoisted(() => ({
  approveStoryboardStage: vi.fn(),
  attachStoryboardKeyframe: vi.fn(),
  attachStoryboardClip: vi.fn(),
  selectStoryboardTake: vi.fn(),
  hideStoryboardTake: vi.fn(),
}));
vi.mock("@/mcp/tools/storyboard-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools/storyboard-tools")>()),
  ...sb,
}));
const cache = vi.hoisted(() => ({
  getModelSchemaCacheTool: vi.fn(),
  saveModelSchemaCacheTool: vi.fn(),
  invalidateModelSchemaCacheTool: vi.fn(),
}));
vi.mock("@/mcp/tools/model-schema-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools/model-schema-tools")>()),
  ...cache,
}));

const fx = vi.hoisted(() => ({ listEffectsTool: vi.fn() }));
vi.mock("@/mcp/tools/effect-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools/effect-tools")>()),
  ...fx,
}));
const pkg = vi.hoisted(() => ({
  installEffectFromGitTool: vi.fn(),
  addEffectTool: vi.fn(),
  updateEffectTool: vi.fn(),
  removeEffectTool: vi.fn(),
  listEffectPackagesTool: vi.fn(),
}));
vi.mock("@/mcp/tools/effect-package-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools/effect-package-tools")>()),
  ...pkg,
}));
const presets = vi.hoisted(() => ({
  saveOverlayPreset: vi.fn(),
  applyOverlayPreset: vi.fn(),
  listOverlayPresets: vi.fn(),
  deleteOverlayPreset: vi.fn(),
}));
vi.mock("@/mcp/tools/overlay-preset-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools/overlay-preset-tools")>()),
  ...presets,
}));

const snap = vi.hoisted(() => ({
  commitDraftTool: vi.fn(),
  discardDraftTool: vi.fn(),
  restoreSnapshotTool: vi.fn(),
  compareStatesTool: vi.fn(),
}));
vi.mock("@/mcp/tools/snapshot-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools/snapshot-tools")>()),
  ...snap,
}));
const social = vi.hoisted(() => ({ socialLinkPost: vi.fn(), socialLinkAd: vi.fn() }));
vi.mock("@/mcp/tools/social-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools/social-tools")>()),
  ...social,
}));

import { createLibiMcpServer } from "@/mcp/server";
import { notify } from "@/mcp/notify";
import { MERGED_TOOL_DISCRIMINATORS } from "@/lib/agents/merged-tools";
import { registeredMergedTools } from "@/mcp/tools/action-registry";

const NEW_TOOLS = {
  "libi.piece_folder": ["create", "rename", "move", "delete", "list", "move_piece", "duplicate"],
  "libi.asset_folder": ["create", "rename", "move", "delete", "move_asset"],
  "libi.clip": ["delete", "split", "duplicate", "insert_time"],
  "libi.audio_clip": ["update", "remove", "split", "unlink", "relink_overlay"],
  "libi.storyboard_take": ["attach_clip", "attach_keyframe", "select", "hide", "approve_stage"],
  "libi.model_schema_cache": ["get", "save", "invalidate"],
  "libi.effect": ["list", "list_packages", "add", "update", "remove", "install_from_git"],
  "libi.overlay_preset": ["save", "apply", "list", "delete"],
  "libi.snapshot": ["commit", "discard", "restore", "compare"],
  "libi.social_link": ["post", "ad"],
} as const satisfies Record<string, readonly string[]>;

const OLD_TOOLS = [
  "libi.create_folder", "libi.rename_folder", "libi.move_folder", "libi.delete_folder", "libi.list_folders",
  "libi.move_piece_to_folder", "libi.duplicate_folder",
  "libi.create_asset_folder", "libi.rename_asset_folder", "libi.move_asset_folder", "libi.delete_asset_folder", "libi.move_asset",
  "libi.delete_clip", "libi.split_clip", "libi.duplicate_clip",
  "libi.audio_update_clip", "libi.audio_remove_clip", "libi.audio_split", "libi.audio_unlink", "libi.audio_relink_overlay",
  "libi.attach_storyboard_clip", "libi.attach_storyboard_keyframe", "libi.select_storyboard_take", "libi.hide_storyboard_take",
  "libi.approve_storyboard_stage", "libi.get_model_schema_cache", "libi.save_model_schema_cache", "libi.invalidate_model_schema_cache",
  "libi.list_effects", "libi.list_effect_packages", "libi.add_effect", "libi.update_effect", "libi.remove_effect", "libi.install_effect_from_git",
  "libi.save_overlay_preset", "libi.apply_overlay_preset", "libi.list_overlay_presets", "libi.delete_overlay_preset",
  "libi.commit_draft", "libi.discard_draft", "libi.restore_snapshot", "libi.compare_states", "libi.social_link_post", "libi.social_link_ad",
];

async function connectTo(server: ReturnType<typeof createLibiMcpServer>) {
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
const connect = (surface: "cli" | "in-app" = "in-app") => connectTo(createLibiMcpServer({ surface }));

let refresh: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  for (const group of [folders, dup, assetFolders, clips, audio, sb, cache, fx, pkg, presets, snap, social]) for (const fn of Object.values(group)) fn.mockReset();
  vi.restoreAllMocks();
  refresh = vi.spyOn(notify, "refreshQuery").mockImplementation(() => undefined);
});

describe("the tool list", () => {
  it.each(["cli", "in-app"] as const)("(%s) carries the merged tools and none of the per-verb ones they replace", async (surface) => {
    const h = await connect(surface);
    const names = (await h.tools()).map((t) => t.name);
    for (const n of Object.keys(NEW_TOOLS)) expect(names, n).toContain(n);
    for (const old of OLD_TOOLS) expect(names, old).not.toContain(old);
    await h.close();
  });

  it("registers exactly the declared actions with the declared discriminator", async () => {
    await (await connect()).close();
    for (const [n, actions] of Object.entries(NEW_TOOLS)) {
      expect([...registeredMergedTools().get(n)!.actions], n).toEqual(actions);
      expect(MERGED_TOOL_DISCRIMINATORS[n as keyof typeof MERGED_TOOL_DISCRIMINATORS]).toBe(n === "libi.social_link" ? "kind" : "action");
    }
  });

  it("each is flat (no anyOf), requires only `action`, and its description names every action", async () => {
    const h = await connect();
    const byName = new Map((await h.tools()).map((t) => [t.name, t]));
    for (const [n, actions] of Object.entries(NEW_TOOLS)) {
      const t = byName.get(n)!;
      expect(t.inputSchema.required, n).toEqual([n === "libi.social_link" ? "kind" : "action"]);
      expect(JSON.stringify(t.inputSchema), n).not.toMatch(/anyOf|oneOf/);
      for (const a of actions) expect(t.description, `${n} names ${a}`).toContain(a);
    }
    await h.close();
  });
});

describe("libi.piece_folder", () => {
  it("create / rename / move refresh the folder tree and pass the parsed arguments through", async () => {
    folders.createFolderTool.mockResolvedValue(ok({ folderId: "f1" }));
    folders.renameFolderTool.mockResolvedValue(ok());
    folders.moveFolderTool.mockResolvedValue(ok());
    const h = await connect();
    expect((await h.call("libi.piece_folder", { action: "create", name: "Ads", parentFolderId: "p" })).json).toEqual(ok({ folderId: "f1" }));
    // the advertised `null` (top level) is accepted for create as it is for move
    expect((await h.call("libi.piece_folder", { action: "create", name: "Top", parentFolderId: null })).json).toEqual(ok({ folderId: "f1" }));
    expect(folders.createFolderTool).toHaveBeenLastCalledWith({ name: "Top", parentFolderId: null });
    expect(folders.createFolderTool).toHaveBeenCalledWith({ name: "Ads", parentFolderId: "p" });
    await h.call("libi.piece_folder", { action: "rename", folderId: "f1", name: "Ads 2" });
    expect(folders.renameFolderTool).toHaveBeenCalledWith({ folderId: "f1", name: "Ads 2" });
    await h.call("libi.piece_folder", { action: "move", folderId: "f1", parentFolderId: null });
    expect(folders.moveFolderTool).toHaveBeenCalledWith({ folderId: "f1", parentFolderId: null });
    expect(refresh).toHaveBeenCalledTimes(4);
    expect(refresh).toHaveBeenCalledWith({ queryKey: "folders" });
    await h.close();
  });

  it("delete / move_piece / duplicate refresh folders AND pieces, only on success; list takes no arguments", async () => {
    folders.deleteFolderTool.mockResolvedValue(ok());
    folders.movePieceToFolderTool.mockResolvedValue(ok());
    folders.listFoldersTool.mockResolvedValue(ok({ folders: [] }));
    dup.duplicateFolderTool.mockResolvedValue(ok({ jobIds: ["j"] }));
    const h = await connect();
    await h.call("libi.piece_folder", { action: "delete", folderId: "f1", mode: "cascade", confirm: true });
    expect(folders.deleteFolderTool).toHaveBeenCalledWith({ folderId: "f1", mode: "cascade", confirm: true });
    expect(refresh.mock.calls.map((c: unknown[]) => (c[0] as { queryKey: string }).queryKey)).toEqual(["folders", "pieces"]);
    refresh.mockClear();
    await h.call("libi.piece_folder", { action: "move_piece", pieceId: "p1", folderId: null });
    expect(folders.movePieceToFolderTool).toHaveBeenCalledWith({ pieceId: "p1", folderId: null });
    expect(refresh).toHaveBeenCalledTimes(2);
    refresh.mockClear();
    const copy = await h.call("libi.piece_folder", { action: "duplicate", folderId: "f1", name: "Copy", source: "snapshot" });
    expect(copy.json).toEqual(ok({ jobIds: ["j"] }));
    expect(dup.duplicateFolderTool).toHaveBeenCalledWith({ folderId: "f1", name: "Copy", source: "snapshot" });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect((await h.call("libi.piece_folder", { action: "list" })).json).toEqual(ok({ folders: [] }));
    refresh.mockClear();
    folders.deleteFolderTool.mockResolvedValue({ success: false, error: "no" });
    await h.call("libi.piece_folder", { action: "delete", folderId: "f1", mode: "orphan" });
    expect(refresh).not.toHaveBeenCalled();
    await h.close();
  });

  it("refuses a call with the wrong arguments, naming the action's fields, and runs nothing", async () => {
    const h = await connect();
    const bad = await h.call("libi.piece_folder", { action: "delete", folderId: "f1" });
    expect(bad.isError).toBe(true);
    expect(bad.json.error).toContain("delete requires: folderId, mode");
    expect(folders.deleteFolderTool).not.toHaveBeenCalled();
    const unknown = await h.call("libi.piece_folder", { action: "explode" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("move_piece");
    await h.close();
  });

  it("keeps the duplicate action's job note: jobIds, polling libi.job, and the disk cost", async () => {
    const h = await connect();
    const t = (await h.tools()).find((x) => x.name === "libi.piece_folder")!;
    const action = (t.inputSchema.properties as Record<string, { description: string }>).action.description;
    expect(action).toMatch(/jobIds/);
    expect(action).toContain('libi.job({ action: "status", jobId })');
    expect(action).toMatch(/disk cost/);
    await h.close();
  });
});

describe("libi.asset_folder", () => {
  it("every action refreshes the asset folders of the SCOPE it changed (the panel keys by scope); delete and move_asset refresh the files too", async () => {
    assetFolders.createAssetFolderTool.mockResolvedValue(ok({ folderId: "a1" }));
    assetFolders.renameAssetFolderTool.mockResolvedValue(ok());
    assetFolders.moveAssetFolderTool.mockResolvedValue(ok());
    assetFolders.deleteAssetFolderTool.mockResolvedValue(ok());
    assetFolders.moveAssetTool.mockResolvedValue(ok());
    assetFolders.assetFolderPieceId.mockReturnValue("p1");
    assetFolders.filePieceId.mockReturnValue("p1");
    const h = await connect();
    await h.call("libi.asset_folder", { action: "create", pieceId: "p1", name: "Takes" });
    expect(assetFolders.createAssetFolderTool).toHaveBeenCalledWith({ pieceId: "p1", name: "Takes" });
    expect(refresh).toHaveBeenLastCalledWith({ queryKey: "asset-folders", pieceId: "p1" });
    await h.call("libi.asset_folder", { action: "create", pieceId: null, name: "Global" });
    expect(assetFolders.createAssetFolderTool).toHaveBeenLastCalledWith({ pieceId: null, name: "Global" });
    expect(refresh).toHaveBeenLastCalledWith({ queryKey: "asset-folders", pieceId: undefined });
    refresh.mockClear();
    await h.call("libi.asset_folder", { action: "rename", folderId: "a1", name: "T" });
    expect(assetFolders.assetFolderPieceId).toHaveBeenCalledWith("a1");
    expect(refresh.mock.calls).toEqual([[{ queryKey: "asset-folders", pieceId: "p1" }]]);
    refresh.mockClear();
    await h.call("libi.asset_folder", { action: "move", folderId: "a1", parentFolderId: null });
    expect(assetFolders.moveAssetFolderTool).toHaveBeenCalledWith({ folderId: "a1", parentFolderId: null });
    expect(refresh.mock.calls).toEqual([[{ queryKey: "asset-folders", pieceId: "p1" }]]);
    refresh.mockClear();
    await h.call("libi.asset_folder", { action: "delete", folderId: "a1" });
    expect(assetFolders.deleteAssetFolderTool).toHaveBeenCalledWith({ folderId: "a1", mode: "orphan" });
    expect(refresh.mock.calls).toEqual([[{ queryKey: "asset-folders", pieceId: "p1" }], [{ queryKey: "files", pieceId: "p1" }]]);
    refresh.mockClear();
    await h.call("libi.asset_folder", { action: "move_asset", fileId: "f", folderId: null });
    expect(assetFolders.moveAssetTool).toHaveBeenCalledWith({ fileId: "f", folderId: null });
    expect(assetFolders.filePieceId).toHaveBeenCalledWith("f");
    expect(refresh.mock.calls).toEqual([[{ queryKey: "asset-folders", pieceId: "p1" }], [{ queryKey: "files", pieceId: "p1" }]]);
    // a failed call refreshes nothing
    refresh.mockClear();
    assetFolders.deleteAssetFolderTool.mockResolvedValue({ success: false, error: "confirm_required" });
    await h.call("libi.asset_folder", { action: "delete", folderId: "a1", mode: "cascade" });
    expect(refresh).not.toHaveBeenCalled();
    await h.close();
  });

  it("carries the folded invariants in its description: one asset = one file, group related assets, no default file, cascade only on explicit intent", async () => {
    const h = await connect();
    const t = (await h.tools()).find((x) => x.name === "libi.asset_folder")!;
    expect(t.description).toMatch(/One asset is one file/);
    expect(t.description).toMatch(/group related assets/);
    expect(t.description).toMatch(/no default or active file/);
    const action = (t.inputSchema.properties as Record<string, { description: string }>).action.description;
    expect(action).toMatch(/mode 'cascade' only on the user's explicit intent/);
    expect(action).toMatch(/'orphan' \(default, safe\)/);
    await h.close();
  });

  it("refuses cascade without confirm through the original handler (`confirm` is validated by the handler)", async () => {
    assetFolders.deleteAssetFolderTool.mockResolvedValue({ success: false, error: "confirm_required" });
    const h = await connect();
    const res = await h.call("libi.asset_folder", { action: "delete", folderId: "a1", mode: "cascade" });
    expect(res.json).toEqual({ success: false, error: "confirm_required" });
    await h.close();
  });
});

describe("libi.clip", () => {
  it("delete / split / duplicate run the clip handler with the parsed arguments and refresh the composition on success only", async () => {
    clips.deleteClipTool.mockResolvedValue(ok());
    clips.splitClipTool.mockResolvedValue(ok({ tailId: "t" }));
    clips.duplicateClipTool.mockResolvedValue(ok({ newId: "n" }));
    clips.insertTimeTool.mockResolvedValue(ok({ shifted: ["a"] }));
    const h = await connect();
    // `ripple` defaults to false in the action's own schema
    await h.call("libi.clip", { action: "delete", pieceId: "p", targetId: "o1" });
    expect(clips.deleteClipTool).toHaveBeenCalledWith({ pieceId: "p", targetId: "o1", ripple: false });
    await h.call("libi.clip", { action: "delete", pieceId: "p", targetId: "o1", ripple: true });
    expect(clips.deleteClipTool).toHaveBeenLastCalledWith({ pieceId: "p", targetId: "o1", ripple: true });
    expect((await h.call("libi.clip", { action: "split", pieceId: "p", targetId: "o1", atTime: 2 })).json).toEqual(ok({ tailId: "t" }));
    expect(clips.splitClipTool).toHaveBeenCalledWith({ pieceId: "p", targetId: "o1", atTime: 2 });
    expect((await h.call("libi.clip", { action: "duplicate", pieceId: "p", targetId: "o1" })).json).toEqual(ok({ newId: "n" }));
    expect((await h.call("libi.clip", { action: "insert_time", pieceId: "p", at: 5, seconds: 3, stretch: "none", extendTarget: "vid-1" })).json).toEqual(ok({ shifted: ["a"] }));
    expect(clips.insertTimeTool).toHaveBeenCalledWith({ pieceId: "p", at: 5, seconds: 3, stretch: ["none"], extendTarget: "vid-1" });
    expect(refresh).toHaveBeenCalledTimes(5);
    expect(refresh).toHaveBeenLastCalledWith({ queryKey: "composition", pieceId: "p" });
    refresh.mockClear();
    clips.splitClipTool.mockResolvedValue({ success: false, error: "outside" });
    await h.call("libi.clip", { action: "split", pieceId: "p", targetId: "o1", atTime: 99 });
    expect(refresh).not.toHaveBeenCalled();
    const bad = await h.call("libi.clip", { action: "split", pieceId: "p", targetId: "o1" });
    expect(bad.json.error).toContain("split requires: pieceId, targetId, atTime");
    await h.close();
  });

  it("keeps the ripple semantics in the delete action's text", async () => {
    const h = await connect();
    const t = (await h.tools()).find((x) => x.name === "libi.clip")!;
    const props = t.inputSchema.properties as Record<string, { description: string }>;
    expect(props.action.description).toMatch(/source file is never deleted/);
    expect(props.ripple.description).toMatch(/timeline-wide/);
    await h.close();
  });
});

describe("libi.audio_clip", () => {
  it("each action runs the audio handler with the piece context and the parsed arguments, refreshing the composition", async () => {
    for (const fn of Object.values(audio)) fn.mockResolvedValue(ok());
    const h = await connect();
    await h.call("libi.audio_clip", { action: "update", pieceId: "p", clipId: "c", enabled: false });
    expect(audio.audioUpdateClip).toHaveBeenCalledWith({ pieceId: "p" }, { pieceId: "p", clipId: "c", enabled: false });
    await h.call("libi.audio_clip", { action: "remove", pieceId: "p", clipId: "c" });
    expect(audio.audioRemoveClip).toHaveBeenCalledWith({ pieceId: "p" }, { pieceId: "p", clipId: "c" });
    audio.audioSplit.mockResolvedValue(ok({ tailId: "t" }));
    expect((await h.call("libi.audio_clip", { action: "split", pieceId: "p", clipId: "c", time: 3 })).json).toEqual(ok({ tailId: "t" }));
    expect(audio.audioSplit).toHaveBeenCalledWith({ pieceId: "p" }, { pieceId: "p", clipId: "c", time: 3 });
    await h.call("libi.audio_clip", { action: "unlink", pieceId: "p", clipId: "c" });
    expect(audio.audioUnlink).toHaveBeenCalledWith({ pieceId: "p" }, { pieceId: "p", clipId: "c" });
    await h.call("libi.audio_clip", { action: "relink_overlay", pieceId: "p", clipId: "c", overlayId: "o" });
    expect(audio.audioRelinkOverlay).toHaveBeenCalledWith({ pieceId: "p" }, { pieceId: "p", clipId: "c", overlayId: "o" });
    expect(refresh).toHaveBeenCalledTimes(5);
    refresh.mockClear();
    audio.audioRemoveClip.mockResolvedValue({ success: false, error: "clip_not_found" });
    expect((await h.call("libi.audio_clip", { action: "remove", pieceId: "p", clipId: "x" })).json).toEqual({ success: false, error: "clip_not_found" });
    expect(refresh).not.toHaveBeenCalled();
    const bad = await h.call("libi.audio_clip", { action: "relink_overlay", pieceId: "p", clipId: "c" });
    expect(bad.json.error).toContain("relink_overlay requires: pieceId, clipId, overlayId");
    await h.close();
  });

  it("keeps the remove-vs-delete wording and points at audio_add_clip for adding", async () => {
    const h = await connect();
    const t = (await h.tools()).find((x) => x.name === "libi.audio_clip")!;
    expect(t.description).toContain("libi.audio_add_clip");
    const action = (t.inputSchema.properties as Record<string, { description: string }>).action.description;
    expect(action).toMatch(/NOT deleted/);
    expect(action).toMatch(/stays in resources/);
    await h.close();
  });
});

describe("libi.storyboard_take", () => {
  it("each action runs its handler with the piece context and refreshes the storyboard on success", async () => {
    for (const fn of Object.values(sb)) fn.mockResolvedValue(ok());
    const h = await connect();
    await h.call("libi.storyboard_take", { action: "attach_clip", pieceId: "p", cardId: "c", fileId: "f", costUsd: 1.5 });
    expect(sb.attachStoryboardClip).toHaveBeenCalledWith({ pieceId: "p", cardId: "c", fileId: "f", costUsd: 1.5 }, { pieceId: "p" });
    await h.call("libi.storyboard_take", { action: "attach_keyframe", pieceId: "p", cardId: "c", fileId: "f" });
    expect(sb.attachStoryboardKeyframe).toHaveBeenCalledWith({ pieceId: "p", cardId: "c", fileId: "f" }, { pieceId: "p" });
    await h.call("libi.storyboard_take", { action: "select", pieceId: "p", cardId: "c", takeId: "t" });
    expect(sb.selectStoryboardTake).toHaveBeenCalledWith({ pieceId: "p", cardId: "c", takeId: "t" }, { pieceId: "p" });
    await h.call("libi.storyboard_take", { action: "hide", pieceId: "p", cardId: "c", takeId: "t" });
    expect(sb.hideStoryboardTake).toHaveBeenCalledWith({ pieceId: "p", cardId: "c", takeId: "t" }, { pieceId: "p" });
    expect(refresh.mock.calls.map((c: unknown[]) => c[0])).toEqual(Array(4).fill({ queryKey: "storyboard", pieceId: "p" }));
    await h.close();
  });

  it("approve_stage refreshes the composition too, but only for the clip stage", async () => {
    sb.approveStoryboardStage.mockResolvedValue(ok());
    const h = await connect();
    await h.call("libi.storyboard_take", { action: "approve_stage", pieceId: "p", cardId: "c", stage: "keyframe" });
    expect(refresh.mock.calls.map((c: unknown[]) => (c[0] as { queryKey: string }).queryKey)).toEqual(["storyboard"]);
    refresh.mockClear();
    await h.call("libi.storyboard_take", { action: "approve_stage", pieceId: "p", cardId: "c", stage: "clip" });
    expect(sb.approveStoryboardStage).toHaveBeenLastCalledWith({ pieceId: "p", cardId: "c", stage: "clip" }, { pieceId: "p" });
    expect(refresh.mock.calls.map((c: unknown[]) => (c[0] as { queryKey: string }).queryKey)).toEqual(["storyboard", "composition"]);
    refresh.mockClear();
    sb.approveStoryboardStage.mockResolvedValue({ success: false, error: "previous_tier_not_approved" });
    expect((await h.call("libi.storyboard_take", { action: "approve_stage", pieceId: "p", cardId: "c", stage: "clip" })).json).toEqual({ success: false, error: "previous_tier_not_approved" });
    expect(refresh).not.toHaveBeenCalled();
    const bad = await h.call("libi.storyboard_take", { action: "approve_stage", pieceId: "p", cardId: "c", stage: "final" });
    expect(bad.isError).toBe(true);
    await h.close();
  });
});

describe("libi.model_schema_cache", () => {
  it("get / save / invalidate call the cache handlers with an empty piece context", async () => {
    cache.getModelSchemaCacheTool.mockResolvedValue(ok({ exists: false }));
    cache.saveModelSchemaCacheTool.mockResolvedValue(ok());
    cache.invalidateModelSchemaCacheTool.mockResolvedValue(ok());
    const h = await connect();
    expect((await h.call("libi.model_schema_cache", { action: "get", apiUrl: "https://fal.run", model: "m" })).json).toEqual(ok({ exists: false }));
    expect(cache.getModelSchemaCacheTool).toHaveBeenCalledWith({ apiUrl: "https://fal.run", model: "m" }, { pieceId: "" });
    const fields = [{ key: "prompt", type: "text", required: true }];
    await h.call("libi.model_schema_cache", { action: "save", apiUrl: "u", model: "m", fields, source: "fal" });
    expect(cache.saveModelSchemaCacheTool).toHaveBeenCalledWith({ apiUrl: "u", model: "m", fields, source: "fal" }, { pieceId: "" });
    await h.call("libi.model_schema_cache", { action: "invalidate", apiUrl: "u", model: "m" });
    expect(cache.invalidateModelSchemaCacheTool).toHaveBeenCalledWith({ apiUrl: "u", model: "m" }, { pieceId: "" });
    await h.close();
  });

  it("save still validates the field defs and names the action's fields", async () => {
    const h = await connect();
    const bad = await h.call("libi.model_schema_cache", { action: "save", apiUrl: "u", model: "m", fields: [{ key: "prompt", type: "bogus" }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/fields/);
    expect(cache.saveModelSchemaCacheTool).not.toHaveBeenCalled();
    const missing = await h.call("libi.model_schema_cache", { action: "save", apiUrl: "u", model: "m" });
    expect(missing.json.error).toContain("save requires: apiUrl, model, fields");
    await h.close();
  });
});

describe("libi.effect", () => {
  it("add / update / remove / install_from_git run their handler and refresh the custom effects only on success", async () => {
    for (const fn of Object.values(pkg)) fn.mockResolvedValue(ok());
    const h = await connect();
    const manifest = { id: "slow-drift", name: "Slow drift", family: "animation", phases: ["loop"], supports: ["text"], source: "return { dx: progress };" };
    await h.call("libi.effect", { action: "add", ...manifest });
    expect(pkg.addEffectTool).toHaveBeenCalledWith(manifest);
    await h.call("libi.effect", { action: "update", id: "slow-drift", source: "return {};" });
    expect(pkg.updateEffectTool).toHaveBeenCalledWith({ id: "slow-drift", source: "return {};" });
    await h.call("libi.effect", { action: "remove", id: "slow-drift" });
    expect(pkg.removeEffectTool).toHaveBeenCalledWith({ id: "slow-drift" });
    await h.call("libi.effect", { action: "install_from_git", url: "https://example.com/r.git" });
    expect(pkg.installEffectFromGitTool).toHaveBeenCalledWith({ url: "https://example.com/r.git" });
    expect(refresh.mock.calls).toEqual(Array(4).fill([{ queryKey: "effects-custom" }]));
    refresh.mockClear();
    pkg.addEffectTool.mockResolvedValue({ success: false, error: "validation_failed", data: { hint: "bad" } });
    expect((await h.call("libi.effect", { action: "add", ...manifest })).json.error).toBe("validation_failed");
    expect(refresh).not.toHaveBeenCalled();
    await h.close();
  });

  it("list / list_packages refresh nothing; list keeps accepting the retired kind 'scene' as 'video'", async () => {
    fx.listEffectsTool.mockResolvedValue(ok({ effects: [] }));
    pkg.listEffectPackagesTool.mockResolvedValue(ok({ packages: [] }));
    const h = await connect();
    await h.call("libi.effect", { action: "list", kind: "scene", phase: "in" });
    expect(fx.listEffectsTool).toHaveBeenCalledWith({ kind: "video", phase: "in" });
    expect((await h.call("libi.effect", { action: "list_packages" })).json).toEqual(ok({ packages: [] }));
    expect(refresh).not.toHaveBeenCalled();
    await h.close();
  });

  it("advertises every action's properties, tells layer_effect apart, and wide-types `family`", async () => {
    const h = await connect();
    const t = (await h.tools()).find((x) => x.name === "libi.effect")!;
    expect(t.description).toContain("libi.layer_effect");
    const props = t.inputSchema.properties as Record<string, { type?: string; description?: string }>;
    for (const k of ["id", "name", "family", "phases", "supports", "params", "source", "manifest", "url", "kind", "phase"]) expect(props[k], k).toBeDefined();
    expect(props.family.type).toBe("string");
    const bad = await h.call("libi.effect", { action: "remove" });
    expect(bad.json.error).toContain("remove requires: id");
    await h.close();
  });
});

describe("libi.overlay_preset", () => {
  it("save / list / delete pass through untouched; apply refreshes the composition on success", async () => {
    presets.saveOverlayPreset.mockResolvedValue(ok({ presetId: "gold" }));
    presets.listOverlayPresets.mockResolvedValue(ok({ presets: [] }));
    presets.deleteOverlayPreset.mockResolvedValue(ok());
    presets.applyOverlayPreset.mockResolvedValue({ success: true });
    const h = await connect();
    expect((await h.call("libi.overlay_preset", { action: "save", pieceId: "p", overlayId: "o", name: "Gold", override: true })).json).toEqual(ok({ presetId: "gold" }));
    expect(presets.saveOverlayPreset).toHaveBeenCalledWith({ pieceId: "p", overlayId: "o", name: "Gold", override: true });
    await h.call("libi.overlay_preset", { action: "list", kind: "text" });
    expect(presets.listOverlayPresets).toHaveBeenCalledWith({ kind: "text" });
    await h.call("libi.overlay_preset", { action: "delete", presetId: "gold" });
    expect(presets.deleteOverlayPreset).toHaveBeenCalledWith({ presetId: "gold" });
    expect(refresh).not.toHaveBeenCalled();
    await h.call("libi.overlay_preset", { action: "apply", pieceId: "p", overlayId: "o", presetId: "gold" });
    expect(presets.applyOverlayPreset).toHaveBeenCalledWith({ pieceId: "p", overlayId: "o", presetId: "gold" });
    expect(refresh).toHaveBeenCalledWith({ queryKey: "composition", pieceId: "p" });
    refresh.mockClear();
    presets.applyOverlayPreset.mockResolvedValue({ success: false, error: "kind_mismatch" });
    await h.call("libi.overlay_preset", { action: "apply", pieceId: "p", overlayId: "o", presetId: "gold" });
    expect(refresh).not.toHaveBeenCalled();
    await h.close();
  });

  it("keeps the name-collision wording (`preset_name_exists`, override, reserved bundled names)", async () => {
    const h = await connect();
    const t = (await h.tools()).find((x) => x.name === "libi.overlay_preset")!;
    const action = (t.inputSchema.properties as Record<string, { description: string }>).action.description;
    expect(action).toMatch(/preset_name_exists/);
    expect(action).toMatch(/override:true/);
    expect(action).toMatch(/preset_name_reserved/);
    await h.close();
  });
});

describe("libi.snapshot", () => {
  it("each action runs its handler with the parsed arguments and returns its result unchanged", async () => {
    snap.commitDraftTool.mockResolvedValue(ok({ snapshotId: "s1", summary: "x", committedAt: 1 }));
    snap.discardDraftTool.mockResolvedValue(ok({ pieceId: "p" }));
    snap.restoreSnapshotTool.mockResolvedValue(ok({ pieceId: "p", snapshotId: "s0" }));
    snap.compareStatesTool.mockResolvedValue(ok({ hasDraft: true, totalChanges: 2 }));
    const h = await connect();
    expect((await h.call("libi.snapshot", { action: "commit", pieceId: "p", summary: "x", acknowledgeUnvalidated: true })).json).toEqual(ok({ snapshotId: "s1", summary: "x", committedAt: 1 }));
    expect(snap.commitDraftTool).toHaveBeenCalledWith({ pieceId: "p", summary: "x", acknowledgeUnvalidated: true });
    await h.call("libi.snapshot", { action: "discard", pieceId: "p", confirm: true });
    expect(snap.discardDraftTool).toHaveBeenCalledWith({ pieceId: "p", confirm: true });
    await h.call("libi.snapshot", { action: "restore", pieceId: "p", snapshotId: "s0", confirm: true });
    expect(snap.restoreSnapshotTool).toHaveBeenCalledWith({ pieceId: "p", snapshotId: "s0", confirm: true });
    expect((await h.call("libi.snapshot", { action: "compare", pieceId: "p" })).json).toEqual(ok({ hasDraft: true, totalChanges: 2 }));
    expect(snap.compareStatesTool).toHaveBeenCalledWith({ pieceId: "p" });
    await h.close();
  });

  it("discard and restore refuse a call without confirm: true, and run nothing", async () => {
    const h = await connect();
    const d = await h.call("libi.snapshot", { action: "discard", pieceId: "p" });
    expect(d.isError).toBe(true);
    expect(d.json.error).toContain("discard requires: pieceId, confirm");
    const r = await h.call("libi.snapshot", { action: "restore", pieceId: "p", snapshotId: "s0", confirm: false });
    expect(r.isError).toBe(true);
    expect(snap.discardDraftTool).not.toHaveBeenCalled();
    expect(snap.restoreSnapshotTool).not.toHaveBeenCalled();
    await h.close();
  });

  it("a storyboard-busy refusal from commit comes back as the busy error, not a plain failure", async () => {
    const { StoryboardBusyError } = await import("@/lib/storyboard/lock");
    snap.commitDraftTool.mockRejectedValue(new StoryboardBusyError());
    const h = await connect();
    const res = await h.call("libi.snapshot", { action: "commit", pieceId: "p" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/storyboard|busy|re-read/i);
    await h.close();
  });

  it("carries the folded rules in the action texts: ask before committing, confirm before discarding, undo without regenerating, the validate-clips gate", async () => {
    const h = await connect();
    const t = (await h.tools()).find((x) => x.name === "libi.snapshot")!;
    const props = t.inputSchema.properties as Record<string, { description: string }>;
    const d = props.action.description;
    const slice = (from: string, to?: string) => d.slice(d.indexOf(`${from} = `), to ? d.indexOf(`; ${to} = `) : undefined);
    const parts = { commit: slice("commit", "discard"), discard: slice("discard", "restore"), restore: slice("restore", "compare") };
    expect(parts.commit).toMatch(/ask the user before committing/);
    expect(parts.commit).toMatch(/never commit automatically/);
    expect(parts.commit).toMatch(/unvalidated_generated_clips/);
    expect(parts.commit).toMatch(/video-analysis/);
    expect(parts.commit).toMatch(/acknowledgeUnvalidated: true/);
    expect(parts.discard).toMatch(/only after the user's explicit confirmation/);
    expect(parts.discard).toMatch(/never regenerate from scratch/);
    expect(parts.restore).toMatch(/user's explicit confirmation/);
    expect(parts.restore).toMatch(/never regenerate from scratch/);
    await h.close();
  });
});

describe("libi.social_link", () => {
  it("kind post / ad run the matching link handler with the parsed arguments", async () => {
    social.socialLinkPost.mockResolvedValue(ok({ linked: true }));
    social.socialLinkAd.mockResolvedValue(ok({ linked: true, navigated: false }));
    const h = await connect();
    expect((await h.call("libi.social_link", { kind: "post", pieceId: "p", providerPostId: "z1", exportPath: "/e.mp4" })).json).toEqual(ok({ linked: true }));
    expect(social.socialLinkPost).toHaveBeenCalledWith({ pieceId: "p", providerPostId: "z1", exportPath: "/e.mp4" });
    await h.call("libi.social_link", { kind: "ad", pieceId: "p", providerAdId: "a1", platformAdId: "m1" });
    expect(social.socialLinkAd).toHaveBeenCalledWith({ pieceId: "p", providerAdId: "a1", platformAdId: "m1" });
    await h.close();
  });

  it("is on both surfaces, uses `kind` as the discriminator, and each kind names its own required id", async () => {
    for (const surface of ["cli", "in-app"] as const) {
      const h = await connect(surface);
      const t = (await h.tools()).find((x) => x.name === "libi.social_link")!;
      expect(t, surface).toBeTruthy();
      expect(t.inputSchema.required).toEqual(["kind"]);
      expect((t.inputSchema.properties as Record<string, { enum?: string[] }>).kind.enum).toEqual(["post", "ad"]);
      await h.close();
    }
    const h = await connect();
    const missingPost = await h.call("libi.social_link", { kind: "post", pieceId: "p" });
    expect(missingPost.json.error).toContain("post requires: pieceId, providerPostId");
    const missingAd = await h.call("libi.social_link", { kind: "ad", pieceId: "p", providerPostId: "z" });
    expect(missingAd.json.error).toContain("ad requires: pieceId, providerAdId");
    expect(social.socialLinkPost).not.toHaveBeenCalled();
    expect(social.socialLinkAd).not.toHaveBeenCalled();
    await h.close();
  });

  it("keeps the ad guidance (no linking a boosted post) and the links-only promise", async () => {
    const h = await connect();
    const t = (await h.tools()).find((x) => x.name === "libi.social_link")!;
    const action = (t.inputSchema.properties as Record<string, { description: string }>).kind.description;
    expect(action).toMatch(/Do NOT use this for an ad that boosts a post/);
    expect(t.description).toMatch(/Records a link only/);
    await h.close();
  });
});
