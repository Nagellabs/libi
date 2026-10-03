/**
 * The M2 merged families, through a REAL server and a real MCP client: `libi.tracked_overlay`,
 * `libi.track`, `libi.analysis_save`, `libi.analysis_query`, `libi.analysis_extract`, `libi.layer_effect`.
 *
 * Each action must call the handler the per-verb tool called, with the same (parsed) arguments, and send
 * its result back unchanged; the handlers themselves are held to their contracts by the function suites
 * (tracking-tools-*, analysis manager, effect-tools). The advertised schema is deliberately loose for the
 * two big nested payloads (`frames`, `summary`) and for tracked-overlay `content`, while the server-side
 * zod still validates the full shape.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const ok = (data: Record<string, unknown> = {}) => ({ success: true as const, data });

const analysis = vi.hoisted(() => ({
  analysisGet: vi.fn(),
  analysisExtractAudio: vi.fn(),
  analysisExtractFrames: vi.fn(),
  analysisSaveSummary: vi.fn(),
  analysisSaveFrames: vi.fn(),
  analysisMarkStepFailed: vi.fn(),
  analysisRemoveStep: vi.fn(),
  analysisUpdateSummaryCustom: vi.fn(),
  analysisSearchFrames: vi.fn(),
  analysisSearchTranscript: vi.fn(),
  analysisChunkAudio: vi.fn(),
  analysisSaveAudioChunk: vi.fn(),
  analysisSaveAudioChunkFromFile: vi.fn(),
  analysisGetAudioChunks: vi.fn(),
}));
vi.mock("@/mcp/tools/analysis-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools/analysis-tools")>()),
  ...analysis,
}));

const trk = vi.hoisted(() => ({
  computeObjectTrack: vi.fn(),
  addTrackedOverlay: vi.fn(),
  updateTrackedOverlay: vi.fn(),
  deleteTrack: vi.fn(),
  listTracks: vi.fn(),
  updateTrackResult: vi.fn(),
  computeTrackSegment: vi.fn(),
  skipSegment: vi.fn(),
  listTrackSegments: vi.fn(),
  groundTarget: vi.fn(),
  listIdentityCandidates: vi.fn(),
  pickCandidate: vi.fn(),
  verifyTrackedOverlay: vi.fn(),
}));
vi.mock("@/mcp/tools/tracking-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools/tracking-tools")>()),
  ...trk,
}));

const fx = vi.hoisted(() => ({ applyLayerEffect: vi.fn(), clearLayerEffect: vi.fn() }));
vi.mock("@/mcp/tools/effect-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools/effect-tools")>()),
  ...fx,
}));

import { createLibiMcpServer } from "@/mcp/server";
import { createTrackingMcpServer } from "@/mcp/tracking-mcp/server";
import { notify } from "@/mcp/notify";
import { MERGED_TOOL_DISCRIMINATORS } from "@/lib/agents/merged-tools";
import { registeredMergedTools } from "@/mcp/tools/action-registry";

const NEW_TOOLS = [
  "libi.tracked_overlay",
  "libi.track",
  "libi.analysis_save",
  "libi.analysis_query",
  "libi.analysis_extract",
  "libi.layer_effect",
] as const;

const OLD_TOOLS = [
  "libi.compute_object_track", "libi.compute_track_segment", "libi.list_tracks", "libi.list_track_segments",
  "libi.delete_track", "libi.update_track_result", "libi.skip_segment", "libi.ground_target",
  "libi.list_identity_candidates", "libi.pick_candidate",
  "libi.add_tracked_overlay", "libi.update_tracked_overlay", "libi.verify_tracked_overlay",
  "libi.analysis_get", "libi.analysis_get_audio_chunks", "libi.analysis_search_frames", "libi.analysis_search_transcript",
  "libi.analysis_save_frames", "libi.analysis_save_summary", "libi.analysis_update_summary_custom",
  "libi.analysis_save_audio_chunk", "libi.analysis_save_audio_chunk_from_file", "libi.analysis_mark_step_failed",
  "libi.analysis_remove_step", "libi.analysis_extract_frames", "libi.analysis_extract_audio", "libi.analysis_chunk_audio",
  "libi.apply_layer_effect", "libi.clear_layer_effect",
];

async function connectTo(server: ReturnType<typeof createLibiMcpServer>) {
  const client = new Client({ name: "t", version: "0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return {
    tools: async (): Promise<Tool[]> => (await client.listTools()).tools,
    raw: (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }),
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

beforeEach(() => {
  for (const group of [analysis, trk, fx]) for (const fn of Object.values(group)) fn.mockReset();
  vi.restoreAllMocks();
});

describe("the tool list", () => {
  it.each(["cli", "in-app"] as const)("(%s) carries the six merged tools and none of the 29 per-verb ones", async (surface) => {
    const h = await connect(surface);
    const names = (await h.tools()).map((t) => t.name);
    for (const n of NEW_TOOLS) expect(names, n).toContain(n);
    for (const old of OLD_TOOLS) expect(names, old).not.toContain(old);
    // the siblings the spec keeps separate
    for (const keep of ["libi.analysis_transcribe_audio", "libi.install_tracking_engine", "libi.remove_background", "libi.verify_install"]) {
      expect(names, keep).toContain(keep);
    }
    await h.close();
  });

  it("the standalone tracking server hosts the same two merged tools", async () => {
    const h = await connectTo(createTrackingMcpServer());
    const names = (await h.tools()).map((t) => t.name);
    expect(names).toContain("libi.track");
    expect(names).toContain("libi.tracked_overlay");
    expect(names.some((n) => OLD_TOOLS.includes(n))).toBe(false);
    await h.close();
  });

  it("registers exactly the declared actions, discriminator `action`", async () => {
    await (await connect()).close();
    const actions = (n: string) => [...registeredMergedTools().get(n)!.actions];
    expect(actions("libi.track")).toEqual([
      "compute", "compute_segment", "list", "list_segments", "delete", "update_result", "skip_segment", "ground_target", "list_candidates", "pick_candidate",
    ]);
    expect(actions("libi.tracked_overlay")).toEqual(["add", "update", "verify"]);
    expect(actions("libi.analysis_save")).toEqual(["frames", "summary", "summary_custom", "audio_chunk", "audio_chunk_from_file", "step_failed", "remove_step"]);
    expect(actions("libi.analysis_query")).toEqual(["get", "audio_chunks", "search_frames", "search_transcript"]);
    expect(actions("libi.analysis_extract")).toEqual(["frames", "audio", "chunk_audio"]);
    expect(actions("libi.layer_effect")).toEqual(["apply", "clear"]);
    for (const n of NEW_TOOLS) expect(MERGED_TOOL_DISCRIMINATORS[n]).toBe("action");
  });

  it("each is flat (no anyOf), requires only `action`, and its description names every action", async () => {
    const h = await connect();
    const byName = new Map((await h.tools()).map((t) => [t.name, t]));
    for (const n of NEW_TOOLS) {
      const t = byName.get(n)!;
      expect(t.inputSchema.required, n).toEqual(["action"]);
      expect(JSON.stringify(t.inputSchema), n).not.toMatch(/anyOf|oneOf/);
      for (const a of registeredMergedTools().get(n)!.actions) expect(t.description, `${n} names ${a}`).toContain(a);
    }
    await h.close();
  });
});

describe("analysis_save: the big nested payloads are advertised loosely and still validated in full", () => {
  it("advertises `frames` as an array of objects and `summary` as an object, each pointing at the skill", async () => {
    const h = await connect();
    const save = (await h.tools()).find((t) => t.name === "libi.analysis_save")!;
    const props = save.inputSchema.properties as Record<string, { type?: string; items?: { type?: string; properties?: unknown }; properties?: unknown; description?: string }>;
    expect(props.frames.type).toBe("array");
    expect(props.frames.items?.type).toBe("object");
    expect(props.frames.items?.properties).toBeUndefined();
    expect(props.summary.type).toBe("object");
    expect(props.summary.properties).toBeUndefined();
    for (const k of ["frames", "summary"]) expect(props[k].description, k).toMatch(/video-analysis skill.*references\/shapes\.md/);
    // the whole tool stays small (the two nested schemas alone were ~5 KB)
    expect(JSON.stringify(save).length).toBeLessThan(5000);
    await h.close();
  });

  it("still refuses a malformed frame / summary with the field path, and runs nothing", async () => {
    const h = await connect();
    const badFrame = await h.call("libi.analysis_save", { action: "frames", fileId: "f", frames: [{ frameIndex: "x", timestamp: 0, filePath: "a.png" }] });
    expect(badFrame.isError).toBe(true);
    expect(badFrame.json.error).toContain("frames.0.frameIndex");
    expect(badFrame.json.error).toContain("frames requires: fileId, frames");
    const badDescription = await h.call("libi.analysis_save", { action: "frames", fileId: "f", frames: [{ frameIndex: 0, timestamp: 0, filePath: "a.png", description: { schema_version: "frame_v1" } }] });
    expect(badDescription.isError).toBe(true);
    expect(badDescription.json.error).toMatch(/frames\.0\.description\.(frame_index|scene|setting|people|objects)/);
    const badSummary = await h.call("libi.analysis_save", { action: "summary", fileId: "f", summary: { schema_version: "video_v1" } });
    expect(badSummary.isError).toBe(true);
    expect(badSummary.json.error).toMatch(/summary\.overview/);
    expect(analysis.analysisSaveFrames).not.toHaveBeenCalled();
    expect(analysis.analysisSaveSummary).not.toHaveBeenCalled();
    await h.close();
  });

  const FRAME = {
    schema_version: "frame_v1", frame_index: 0, timestamp: 0, scene: "a person talks", setting: { location: "room" }, people: [], objects: [],
  };
  const SUMMARY = { schema_version: "video_v1", overview: "o", duration: 3, subjects: [], sections: [], recurring_objects: [] };

  it("passes a valid payload to the handler as the per-verb tool did, and refreshes the analysis tab on success", async () => {
    analysis.analysisSaveFrames.mockResolvedValue(ok({ saved: 1 }));
    analysis.analysisSaveSummary.mockResolvedValue(ok());
    const refresh = vi.spyOn(notify, "refreshQuery").mockImplementation(() => undefined);
    const h = await connect();
    const frames = await h.call("libi.analysis_save", { action: "frames", fileId: "f1", frames: [{ frameIndex: 0, timestamp: 0, filePath: "frame-0001.png", description: FRAME }] });
    expect(frames.json).toEqual({ success: true, data: { saved: 1 } });
    expect(analysis.analysisSaveFrames).toHaveBeenCalledWith({ fileId: "f1", frames: [{ frameIndex: 0, timestamp: 0, filePath: "frame-0001.png", description: FRAME }] });
    expect(refresh).toHaveBeenLastCalledWith({ queryKey: "analysis", fileId: "f1" });
    // a summary sent as a JSON string is still decoded (the schema's preprocess), as before
    await h.call("libi.analysis_save", { action: "summary", fileId: "f2", summary: JSON.stringify(SUMMARY) });
    expect(analysis.analysisSaveSummary).toHaveBeenCalledWith({ fileId: "f2", summary: SUMMARY });
    expect(refresh).toHaveBeenLastCalledWith({ queryKey: "analysis", fileId: "f2" });
    // a FAILED save refreshes nothing
    refresh.mockClear();
    analysis.analysisSaveFrames.mockResolvedValue({ success: false, error: "no" });
    await h.call("libi.analysis_save", { action: "frames", fileId: "f1", frames: [] });
    expect(refresh).not.toHaveBeenCalled();
    await h.close();
  });

  it("routes the remaining save actions, each with its own refresh", async () => {
    for (const fn of [analysis.analysisUpdateSummaryCustom, analysis.analysisMarkStepFailed, analysis.analysisRemoveStep]) fn.mockResolvedValue(ok());
    analysis.analysisSaveAudioChunk.mockResolvedValue(ok({ fileId: "f9" }));
    analysis.analysisSaveAudioChunkFromFile.mockResolvedValue(ok({ fileId: "f8" }));
    const refresh = vi.spyOn(notify, "refreshQuery").mockImplementation(() => undefined);
    const h = await connect();
    await h.call("libi.analysis_save", { action: "summary_custom", fileId: "f", path: "caption_spec", value: { a: 1 } });
    expect(analysis.analysisUpdateSummaryCustom).toHaveBeenCalledWith({ fileId: "f", path: "caption_spec", value: { a: 1 } });
    await h.call("libi.analysis_save", { action: "step_failed", fileId: "f", kind: "frames", errorMessage: "no audio" });
    expect(analysis.analysisMarkStepFailed).toHaveBeenCalledWith({ fileId: "f", kind: "frames", errorMessage: "no audio" });
    await h.call("libi.analysis_save", { action: "remove_step", fileId: "f", kind: "frames" });
    expect(analysis.analysisRemoveStep).toHaveBeenCalledWith({ fileId: "f", kind: "frames" });
    await h.call("libi.analysis_save", { action: "audio_chunk", chunkId: "c1", text: "hi", words: [{ text: "hi", start: 0, end: 1 }] });
    expect(analysis.analysisSaveAudioChunk).toHaveBeenCalledWith({ chunkId: "c1", text: "hi", words: [{ text: "hi", start: 0, end: 1 }] });
    expect(refresh).toHaveBeenLastCalledWith({ queryKey: "analysis", fileId: "f9" });
    await h.call("libi.analysis_save", { action: "audio_chunk_from_file", chunkId: "c2", jsonPath: "/tmp/c2.json" });
    expect(analysis.analysisSaveAudioChunkFromFile).toHaveBeenCalledWith({ chunkId: "c2", jsonPath: "/tmp/c2.json" });
    expect(refresh).toHaveBeenLastCalledWith({ queryKey: "analysis", fileId: "f8" });
    await h.close();
  });

  it("names the action's required fields when one is missing", async () => {
    const h = await connect();
    const res = await h.call("libi.analysis_save", { action: "step_failed", fileId: "f", kind: "frames" });
    expect(res.isError).toBe(true);
    expect(res.json.error).toContain("errorMessage");
    expect(res.json.error).toContain("step_failed requires: fileId, kind, errorMessage");
    await h.close();
  });
});

describe("analysis_query and analysis_extract", () => {
  it("query actions call the read handlers with the parsed arguments", async () => {
    analysis.analysisGet.mockResolvedValue(ok({ steps: [] }));
    analysis.analysisGetAudioChunks.mockResolvedValue(ok({ chunks: [] }));
    analysis.analysisSearchFrames.mockResolvedValue(ok({ frames: [] }));
    analysis.analysisSearchTranscript.mockResolvedValue(ok({ hits: [] }));
    const h = await connect();
    expect((await h.call("libi.analysis_query", { action: "get", fileId: "f", frameDetail: "full" })).json).toEqual({ success: true, data: { steps: [] } });
    expect(analysis.analysisGet).toHaveBeenCalledWith({ fileId: "f", frameDetail: "full" });
    await h.call("libi.analysis_query", { action: "audio_chunks", fileId: "f" });
    expect(analysis.analysisGetAudioChunks).toHaveBeenCalledWith({ fileId: "f" });
    await h.call("libi.analysis_query", { action: "search_frames", fileId: "f", tags: ["a"], time_range: [1, 2] });
    expect(analysis.analysisSearchFrames).toHaveBeenCalledWith({ fileId: "f", tags: ["a"], time_range: [1, 2] });
    await h.call("libi.analysis_query", { action: "search_transcript", fileId: "f", query: "hello", limit: "5" });
    expect(analysis.analysisSearchTranscript).toHaveBeenCalledWith({ fileId: "f", query: "hello", limit: 5 });
    // a tuple of the wrong length is still refused
    expect((await h.call("libi.analysis_query", { action: "search_frames", fileId: "f", time_range: [1] })).isError).toBe(true);
    await h.close();
  });

  it("extract actions: frames and audio write nothing to the tab; chunk_audio refreshes it", async () => {
    analysis.analysisExtractFrames.mockResolvedValue(ok({ frames: [] }));
    analysis.analysisExtractAudio.mockResolvedValue(ok({ path: "/a.wav" }));
    analysis.analysisChunkAudio.mockResolvedValue(ok({ chunks: [] }));
    const refresh = vi.spyOn(notify, "refreshQuery").mockImplementation(() => undefined);
    const h = await connect();
    await h.call("libi.analysis_extract", { action: "frames", fileId: "f", count: "4", timestamps: [0, 1.5] });
    expect(analysis.analysisExtractFrames).toHaveBeenCalledWith({ fileId: "f", count: 4, timestamps: [0, 1.5] });
    await h.call("libi.analysis_extract", { action: "audio", fileId: "f", sampleRate: 16000 });
    expect(analysis.analysisExtractAudio).toHaveBeenCalledWith({ fileId: "f", sampleRate: 16000 });
    expect(refresh).not.toHaveBeenCalled();
    await h.call("libi.analysis_extract", { action: "chunk_audio", fileId: "f", chunkSeconds: 300 });
    expect(analysis.analysisChunkAudio).toHaveBeenCalledWith({ fileId: "f", chunkSeconds: 300 });
    expect(refresh).toHaveBeenCalledWith({ queryKey: "analysis", fileId: "f" });
    await h.close();
  });
});

describe("libi.layer_effect", () => {
  it("apply and clear call the effect handlers (which send their own composition refresh)", async () => {
    fx.applyLayerEffect.mockResolvedValue(ok({ applied: true }));
    fx.clearLayerEffect.mockResolvedValue(ok({ cleared: true }));
    const h = await connect();
    const applied = await h.call("libi.layer_effect", { action: "apply", pieceId: "p", layerId: "o1", phase: "in", effectId: "fade", durationMs: 400 });
    expect(applied.json).toEqual({ success: true, data: { applied: true } });
    expect(fx.applyLayerEffect).toHaveBeenCalledWith({ pieceId: "p", layerId: "o1", phase: "in", effectId: "fade", durationMs: 400 });
    await h.call("libi.layer_effect", { action: "clear", pieceId: "p", layerId: "o1", phase: "in" });
    expect(fx.clearLayerEffect).toHaveBeenCalledWith({ pieceId: "p", layerId: "o1", phase: "in" });
    // an action's own required fields: apply needs an effectId, clear does not
    const missing = await h.call("libi.layer_effect", { action: "apply", pieceId: "p", layerId: "o1", phase: "in" });
    expect(missing.isError).toBe(true);
    expect(missing.json.error).toContain("apply requires: pieceId, layerId, phase, effectId");
    await h.close();
  });
});

describe("libi.track", () => {
  const range = { start: 1, end: 3 };
  const anchors = [{ fileId: "f", time: 1, bbox: [1, 2, 3, 4] }];

  it("routes every action to the handler the per-verb tool used, with the parsed arguments", async () => {
    for (const fn of Object.values(trk)) fn.mockResolvedValue(ok());
    const h = await connect();
    const cases: Array<[Record<string, unknown>, ReturnType<typeof vi.fn>, unknown]> = [
      [{ action: "compute", fileId: "f", objectKind: "face", derivedFromSubjectName: "lisa" }, trk.computeObjectTrack, { fileId: "f", objectKind: "face", derivedFromSubjectName: "lisa" }],
      [{ action: "compute_segment", fileId: "f", trackId: "t", range, method: "sot", anchors }, trk.computeTrackSegment, { fileId: "f", trackId: "t", range, method: "sot", anchors }],
      [{ action: "list", fileId: "f" }, trk.listTracks, { fileId: "f" }],
      [{ action: "list_segments", trackId: "t" }, trk.listTrackSegments, { trackId: "t" }],
      [{ action: "delete", trackId: "t" }, trk.deleteTrack, { trackId: "t" }],
      [{ action: "skip_segment", trackId: "t", range, reason: "gone" }, trk.skipSegment, { trackId: "t", range, reason: "gone" }],
      [{ action: "ground_target", fileId: "f", time: 2, classes: ["person"] }, trk.groundTarget, { fileId: "f", time: 2, classes: ["person"] }],
      [{ action: "pick_candidate", trackId: "t", range, candidateId: 2 }, trk.pickCandidate, { trackId: "t", range, candidateId: 2 }],
    ];
    for (const [args, handler, expected] of cases) {
      const res = await h.call("libi.track", args);
      expect(res.isError, String(args.action)).toBe(false);
      expect(handler, String(args.action)).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0], String(args.action)).toEqual(expected);
    }
    // update_result: the samples keep their defaults and the schema's full validation
    await h.call("libi.track", { action: "update_result", fileId: "f", method: "external-mcp:x", framerate: 30, samples: [{ t: 0, x: 1, y: 1, w: 2, h: 2, visible: true }] });
    expect(trk.updateTrackResult.mock.calls[0][0].samples[0]).toMatchObject({ t: 0, confidence: 1, visible: true });
    await h.close();
  });

  it("hands the MCP `extra` to the handlers that report job progress", async () => {
    trk.computeObjectTrack.mockResolvedValue(ok());
    trk.computeTrackSegment.mockResolvedValue(ok());
    trk.groundTarget.mockResolvedValue(ok());
    trk.pickCandidate.mockResolvedValue(ok());
    const h = await connect();
    await h.call("libi.track", { action: "compute", fileId: "f", objectKind: "object", anchors });
    await h.call("libi.track", { action: "compute_segment", fileId: "f", range, method: "yoloe+botsort", anchors });
    await h.call("libi.track", { action: "ground_target", fileId: "f", time: 1 });
    await h.call("libi.track", { action: "pick_candidate", trackId: "t", range, candidateId: 1 });
    for (const fn of [trk.computeObjectTrack, trk.computeTrackSegment, trk.groundTarget, trk.pickCandidate]) {
      const extra = fn.mock.calls[0][1];
      expect(extra, "extra").toBeTruthy();
      expect(typeof extra.sendNotification, "extra.sendNotification").toBe("function");
    }
    await h.close();
  });

  it("delete refreshes the composition of the piece the track belonged to", async () => {
    trk.deleteTrack.mockResolvedValue(ok({ pieceId: "p1" }));
    const refresh = vi.spyOn(notify, "refreshQuery").mockImplementation(() => undefined);
    const h = await connect();
    await h.call("libi.track", { action: "delete", trackId: "t" });
    expect(refresh).toHaveBeenCalledWith({ queryKey: "composition", pieceId: "p1" });
    await h.close();
  });

  it("list_candidates returns the candidate frames as image blocks, like the per-verb tool", async () => {
    trk.listIdentityCandidates.mockResolvedValue(ok({ ambiguous: true, candidates: [], frames: [{ time: 1, pngBase64: "QUJD" }] }));
    const h = await connect();
    const res = await h.raw("libi.track", { action: "list_candidates", trackId: "t", range });
    const blocks = res.content as Array<{ type: string; data?: string; text?: string }>;
    expect(blocks.map((b) => b.type)).toEqual(["image", "text"]);
    expect(blocks[0].data).toBe("QUJD");
    expect(blocks[1].text).not.toContain("QUJD");
    expect(JSON.parse(blocks[1].text!).data.frames[0]).toMatchObject({ time: 1, hasImage: true });
    await h.close();
  });

  it("names the action's required fields, and keeps the schema's own rules (a range must end after it starts)", async () => {
    const h = await connect();
    const noTrack = await h.call("libi.track", { action: "skip_segment", range, reason: "x" });
    expect(noTrack.isError).toBe(true);
    expect(noTrack.json.error).toContain("skip_segment requires: trackId, range, reason");
    const backwards = await h.call("libi.track", { action: "skip_segment", trackId: "t", range: { start: 3, end: 1 }, reason: "x" });
    expect(backwards.isError).toBe(true);
    // (the advertised flat schema carries the same refine, so the SDK refuses it first, as plain text)
    expect(backwards.text).toContain("range.end must be > range.start");
    const badMethod = await h.call("libi.track", { action: "compute_segment", fileId: "f", range, method: "magic", anchors });
    expect(badMethod.isError).toBe(true);
    expect(badMethod.json.error).toMatch(/method/);
    expect(trk.skipSegment).not.toHaveBeenCalled();
    expect(trk.computeTrackSegment).not.toHaveBeenCalled();
    await h.close();
  });
});

describe("libi.tracked_overlay", () => {
  const add = {
    action: "add", pieceId: "p", trackId: "t", startTime: 0, duration: 4, rect: { x: 0, y: 0, width: 100, height: 100 }, z: 3, opacity: 1,
    content: { kind: "emoji", char: "🙂" }, fit: "tight", scale: 1.1, smoothing: "linear",
  };

  it("advertises `content` as an object keyed by `kind`, and the skill documents every kind", async () => {
    const h = await connect();
    const t = (await h.tools()).find((x) => x.name === "libi.tracked_overlay")!;
    const content = (t.inputSchema.properties as Record<string, { type?: string; properties?: Record<string, { enum?: string[] }>; description?: string }>).content;
    expect(content.type).toBe("object");
    expect(content.properties?.kind.enum).toEqual(["emoji", "text", "image", "video", "code", "effect"]);
    expect(content.description).toMatch(/using-object-tracking skill/);
    await h.close();
  });

  it("add attaches the overlay and refreshes the piece; update does too; failures refresh nothing", async () => {
    trk.addTrackedOverlay.mockResolvedValue(ok({ overlayId: "o1" }));
    trk.updateTrackedOverlay.mockResolvedValue(ok());
    const refresh = vi.spyOn(notify, "refreshQuery").mockImplementation(() => undefined);
    const h = await connect();
    expect((await h.call("libi.tracked_overlay", add)).json).toEqual({ success: true, data: { overlayId: "o1" } });
    const { action: _a, ...addParams } = add;
    void _a;
    expect(trk.addTrackedOverlay).toHaveBeenCalledWith(addParams);
    expect(refresh).toHaveBeenLastCalledWith({ queryKey: "composition", pieceId: "p" });
    refresh.mockClear();
    await h.call("libi.tracked_overlay", { action: "update", pieceId: "p", overlayId: "o1", scale: 4, offset: { x: 0, y: -1 } });
    expect(trk.updateTrackedOverlay).toHaveBeenCalledWith({ pieceId: "p", overlayId: "o1", scale: 4, offset: { x: 0, y: -1 } });
    expect(refresh).toHaveBeenCalledOnce();
    refresh.mockClear();
    trk.addTrackedOverlay.mockResolvedValue({ success: false, error: "track_quality" });
    await h.call("libi.tracked_overlay", add);
    expect(refresh).not.toHaveBeenCalled();
    await h.close();
  });

  it("each action keeps its own bounds: scale <= 5 on add/update, any positive scale on verify; per-kind content fields", async () => {
    trk.verifyTrackedOverlay.mockResolvedValue(ok({ frames: [] }));
    const h = await connect();
    const tooBig = await h.call("libi.tracked_overlay", { ...add, scale: 9 });
    expect(tooBig.isError).toBe(true);
    expect(tooBig.json.error).toMatch(/scale/);
    expect(trk.addTrackedOverlay).not.toHaveBeenCalled();
    // text content needs its fields on add (font, color, align), as before
    const thin = await h.call("libi.tracked_overlay", { ...add, content: { kind: "text", content: "hi" } });
    expect(thin.isError).toBe(true);
    expect(thin.json.error).toMatch(/content\.(font|color|align)/);
    // verify takes the same text content with the optional fields left off, and any positive scale
    const verified = await h.raw("libi.tracked_overlay", { action: "verify", fileId: "f", trackId: "t", content: { kind: "text", content: "hi" }, fit: "tight", scale: 9 });
    expect(verified.isError).toBeFalsy();
    expect(trk.verifyTrackedOverlay).toHaveBeenCalledOnce();
    await h.close();
  });

  it("verify returns the frames as image blocks and a lean text block", async () => {
    trk.verifyTrackedOverlay.mockResolvedValue(ok({ frames: [{ time: 0, pngBase64: "QUJD" }, { time: 1, error: "boom" }], summary: {} }));
    const h = await connect();
    const res = await h.raw("libi.tracked_overlay", { action: "verify", pieceId: "p", overlayId: "o" });
    const blocks = res.content as Array<{ type: string; data?: string; text?: string }>;
    expect(blocks.map((b) => b.type)).toEqual(["image", "text"]);
    expect(JSON.parse(blocks[1].text!).data.frames).toEqual([{ time: 0, hasImage: true }, { time: 1, error: "boom", hasImage: false }]);
    // a failed verify is an error result
    trk.verifyTrackedOverlay.mockResolvedValue({ success: false, error: "nope" });
    const failed = await h.call("libi.tracked_overlay", { action: "verify", pieceId: "p", overlayId: "o" });
    expect(failed.isError).toBe(true);
    expect(failed.json).toEqual({ success: false, error: "nope" });
    await h.close();
  });

  it("smoothing 'kalman' (a legacy value) still becomes 'linear'", async () => {
    trk.addTrackedOverlay.mockResolvedValue(ok());
    const h = await connect();
    await h.call("libi.tracked_overlay", { ...add, smoothing: "kalman" });
    expect(trk.addTrackedOverlay.mock.calls[0][0].smoothing).toBe("linear");
    await h.close();
  });
});
