/**
 * `libi.audio_analyze` through a REAL server and MCP client: the surface (one merged tool, three
 * actions), measure through the jobs client (cache key, refusals, cached rows), report and align on
 * generated audio (real ffmpeg). The numbers themselves are held by loudness / align unit tests and
 * the measure / report integration tests; this file holds the tool.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { hasFfmpeg } from "@/__tests__/helpers/media";
import { synthMusic, wavBytes } from "@/__tests__/helpers/synth-music";
import { files } from "@/lib/db/schema/sqlite";

let storageRoot: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => {
    const { LocalFileStorage } = await import("@/lib/storage/local");
    return new LocalFileStorage(join(storageRoot, "storage"));
  },
}));
const { runJobViaServer, Unavailable } = vi.hoisted(() => ({
  runJobViaServer: vi.fn(),
  Unavailable: class extends Error { hint = "start libi"; },
}));
vi.mock("@/mcp/jobs-client", () => ({
  getJobStatusFromServer: vi.fn(),
  listJobsFromServer: vi.fn(),
  cancelJobOnServer: vi.fn(),
  enqueueJobOnServer: vi.fn(),
  logProxyGenEnqueueFailure: vi.fn(),
  runJobViaServer,
  LibiServerUnavailableError: Unavailable,
}));
vi.mock("@/mcp/tools/social-http", () => ({ api: vi.fn() }));

import { createLibiMcpServer } from "@/mcp/server";

const PIECE = "p_an";
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let testDb: ReturnType<typeof createTestDb>;

async function connect() {
  const server = createLibiMcpServer({ surface: "in-app" });
  const client = new Client({ name: "t", version: "0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return {
    list: async () => (await client.listTools()).tools,
    call: async (args: Record<string, unknown>) => {
      const res = await client.callTool({ name: "libi.audio_analyze", arguments: args });
      const text = (res.content as Array<{ text: string }>)[0].text;
      let json: Json = null;
      try { json = JSON.parse(text); } catch { /* plain-text refusal */ }
      return { isError: !!res.isError, text, json };
    },
    close: async () => { await client.close(); await server.close(); },
  };
}

const writeManifest = (audioClips: unknown[]) =>
  writeFileSync(join(storageRoot, "storage", PIECE, "composition.json"), JSON.stringify({ width: 1080, height: 1920, fps: 30, overlays: [], audioClips }));
const addFile = (id: string, filename: string, bytes: Buffer, duration: number) => {
  writeFileSync(join(storageRoot, "storage", PIECE, filename), bytes);
  testDb.insert(files).values({ id, pieceId: PIECE, filename, name: filename, description: "", type: "audio", storagePath: `${PIECE}/${filename}`, contentType: "audio/wav", size: bytes.length, mediaDuration: duration, hasAudio: true } as never).run();
};
const clip = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: "standalone", fileId: "f-song", startTime: 0, duration: 30, trimStart: 0, volume: 1, enabled: true, ...over });

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "libi-an-"));
  process.env.LIBI_HOME = storageRoot;
  mkdirSync(join(storageRoot, "storage", PIECE), { recursive: true });
  testDb = createTestDb();
  seedPiece(testDb, { id: PIECE });
  runJobViaServer.mockReset();
});
afterEach(() => {
  resetTestDb();
  rmSync(storageRoot, { recursive: true, force: true });
  delete process.env.LIBI_HOME;
});

describe("libi.audio_analyze: the surface", () => {
  it("is ONE merged tool with the three actions, each field described where it applies", async () => {
    const h = await connect();
    const tool = (await h.list()).find((t) => t.name === "libi.audio_analyze")!;
    expect(tool).toBeTruthy();
    const props = (tool.inputSchema as { properties: Record<string, { description?: string; enum?: string[] }>; required?: string[] }).properties;
    expect(props.action.enum).toEqual(["measure", "report", "align"]);
    expect(props.ranges.description).toMatch(/\(measure\)/);
    expect(props.referenceClipId.description).toMatch(/\(align\)/);
    expect(props.step.description).toMatch(/\(report\)/);
    expect(tool.description!.length).toBeLessThan(520);
    // the retired per-verb names never existed; no stale pair in the list
    expect((await h.list()).some((t) => /^libi\.audio_(measure|report|align)$/.test(t.name))).toBe(false);
    await h.close();
  });
});

describe("measure: through the jobs client, cached by the audio", () => {
  beforeEach(() => {
    addFile("f-song", "song.wav", wavBytes(synthMusic(5, 1)), 5);
    writeManifest([clip("bed")]);
  });
  const result = { ranges: [{ from: 1, to: 3, lufs: -20, shortTermMaxLufs: null, rmsDb: -23, peakDb: -20, silent: false }] };

  it("enqueues audio_measure with the ranges, per and a hash of the audio, and returns the job's result", async () => {
    runJobViaServer.mockResolvedValue({ status: "new", jobId: "j1", clientKey: "k", result });
    const h = await connect();
    const r = await h.call({ action: "measure", pieceId: PIECE, ranges: [{ from: 1, to: 3 }] });
    expect(r.json).toMatchObject({ success: true, data: { ranges: [{ lufs: -20, peakDb: -20 }] } });
    expect(r.json.data.cached).toBeUndefined();
    const [kind, params, opts] = runJobViaServer.mock.calls[0];
    expect(kind).toBe("audio_measure");
    expect(params).toMatchObject({ pieceId: PIECE, ranges: [{ from: 1, to: 3 }], per: "mix", mixHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(params.clipIds).toBeUndefined();
    expect(opts.forceNew).toBeUndefined(); // a repeated question is answered from the cache
    await h.close();
  });

  it("the cache key follows the audio: the same piece asks the same params, an edited clip asks different ones", async () => {
    runJobViaServer.mockResolvedValue({ status: "new", jobId: "j", clientKey: "k", result });
    const h = await connect();
    await h.call({ action: "measure", pieceId: PIECE, ranges: [{ from: 1, to: 3 }] });
    await h.call({ action: "measure", pieceId: PIECE, ranges: [{ from: 1, to: 3 }] });
    writeManifest([clip("bed", { gainDb: 3 })]);
    await h.call({ action: "measure", pieceId: PIECE, ranges: [{ from: 1, to: 3 }] });
    const hashes = runJobViaServer.mock.calls.map((c) => (c[1] as { mixHash: string }).mixHash);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
    await h.close();
  });

  it("a cached row says cached: true; a failed or cancelled one is an error, not data", async () => {
    const h = await connect();
    runJobViaServer.mockResolvedValueOnce({ status: "matching_completed", existingJob: { jobId: "j", pieceId: PIECE, completedAt: "x", status: "completed", result } });
    expect((await h.call({ action: "measure", pieceId: PIECE, ranges: [{ from: 1, to: 3 }] })).json).toMatchObject({ success: true, data: { cached: true, ranges: [{ lufs: -20 }] } });
    runJobViaServer.mockResolvedValueOnce({ status: "matching_completed", existingJob: { jobId: "j", pieceId: PIECE, completedAt: "x", status: "failed", error: "boom" } });
    expect((await h.call({ action: "measure", pieceId: PIECE, ranges: [{ from: 1, to: 3 }] })).json).toMatchObject({ success: false, error: "measure_failed", data: { message: "boom" } });
    await h.close();
  });

  it("per 'clip' with clipIds passes them sorted; clipIds without per 'clip' are not sent", async () => {
    runJobViaServer.mockResolvedValue({ status: "new", jobId: "j", clientKey: "k", result });
    const h = await connect();
    await h.call({ action: "measure", pieceId: PIECE, per: "clip", clipIds: ["z", "a"], ranges: [{ from: 1, to: 3 }] });
    await h.call({ action: "measure", pieceId: PIECE, clipIds: ["a"], ranges: [{ from: 1, to: 3 }] });
    expect(runJobViaServer.mock.calls[0][1]).toMatchObject({ per: "clip", clipIds: ["a", "z"] });
    expect(runJobViaServer.mock.calls[1][1].clipIds).toBeUndefined();
    await h.close();
  });

  it("refuses bad ranges before any job is queued, and says what to do when the studio is down", async () => {
    const h = await connect();
    const bad = await h.call({ action: "measure", pieceId: PIECE, ranges: [{ from: 5, to: 3 }] });
    expect(bad.json).toMatchObject({ success: false, error: "invalid_ranges" });
    const wide = await h.call({ action: "measure", pieceId: PIECE, ranges: [{ from: 0, to: 1 }, { from: 700, to: 701 }] });
    expect(wide.json.data.message).toMatch(/at most 600/);
    expect((await h.call({ action: "measure", pieceId: PIECE })).isError).toBe(true);
    expect(runJobViaServer).not.toHaveBeenCalled();
    runJobViaServer.mockRejectedValue(new Unavailable("down"));
    expect((await h.call({ action: "measure", pieceId: PIECE, ranges: [{ from: 1, to: 3 }] })).json).toMatchObject({ error: "libi_server_unavailable", data: { hint: "start libi" } });
    await h.close();
  });
});

const ff = hasFfmpeg() ? describe : describe.skip;

ff("report and align on real audio", () => {
  const song = synthMusic(40, 11);
  beforeEach(() => {
    addFile("f-song", "song.wav", wavBytes(song), 40);
    // The excerpt file: the song from 11.34 s, 7 s long, at half level. The clip plays it from its trimStart 1 for 5 s.
    const from = Math.round(11.34 * 8000);
    addFile("f-ex", "excerpt.wav", wavBytes(song.slice(from, from + 7 * 8000).map((v) => v * 0.5)), 7);
  });

  it("report: the curves of a clip with an envelope, from the tool", async () => {
    writeManifest([clip("bed", { duration: 20, volumeKeyframes: { keyframes: [{ t: 0, value: 0 }, { t: 5, value: -60, easing: "linear" }, { t: 9, value: -60 }, { t: 10, value: 0, easing: "linear" }] } })]);
    const h = await connect();
    const r = await h.call({ action: "report", pieceId: PIECE, from: 0, to: 20, step: 2 });
    expect(r.json.success).toBe(true);
    const c = r.json.data.clips[0];
    expect(c.clipId).toBe("bed");
    expect(c.t.length).toBe(c.outDb.length);
    expect(c.quiet[0].causes.join(" ")).toMatch(/volume envelope/);
    expect(c.outDb[0]).toBe(0);
    expect(r.json.data.silentClips).toBeUndefined();
    const bad = await h.call({ action: "report", pieceId: PIECE, from: 9, to: 3 });
    expect(bad.json).toMatchObject({ success: false, error: "invalid_range" });
    await h.close();
  });

  it("align: where a clip's sound sits inside the song; the continuation point; confidence", async () => {
    writeManifest([clip("tt", { fileId: "f-ex", trimStart: 1, duration: 5 })]);
    const h = await connect();
    const r = await h.call({ action: "align", pieceId: PIECE, fileId: "f-song", referenceClipId: "tt" });
    expect(r.json.success).toBe(true);
    const d = r.json.data;
    expect(Math.abs(d.offsetSec - 12.34)).toBeLessThan(0.01);
    expect(Math.abs(d.endsAtSec - 17.34)).toBeLessThan(0.01);
    expect(d.confidence).toBeGreaterThan(0.6);
    expect(d.note).toMatch(/continuation point/);
    // a window that does not hold it: low confidence says so
    const off = await h.call({ action: "align", pieceId: PIECE, fileId: "f-song", referenceClipId: "tt", window: { from: 20, to: 40 } });
    expect(off.json.data.confidence).toBeLessThan(0.35);
    expect(off.json.data.note).toMatch(/LOW confidence/);
    await h.close();
  });

  it("align: names what is wrong: unknown clip, unknown file, a reference longer than the window", async () => {
    writeManifest([clip("tt", { fileId: "f-ex", trimStart: 0, duration: 7 })]);
    const h = await connect();
    expect((await h.call({ action: "align", pieceId: PIECE, fileId: "f-song", referenceClipId: "ghost" })).json).toMatchObject({ success: false, error: "clip_not_found" });
    expect((await h.call({ action: "align", pieceId: PIECE, fileId: "f-ghost", referenceClipId: "tt" })).json).toMatchObject({ success: false, error: "file_not_found" });
    const tight = await h.call({ action: "align", pieceId: PIECE, fileId: "f-song", referenceClipId: "tt", window: { from: 10, to: 12 } });
    expect(tight.json).toMatchObject({ success: false, error: "cannot_align" });
    expect(tight.json.data.message).toMatch(/longer than the part/);
    await h.close();
  });
});

