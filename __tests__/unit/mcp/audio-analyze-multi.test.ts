/**
 * `libi.audio_analyze` measure / report over several pieces in ONE call, and `libi.list_files` over several pieces
 * (the benchmark's per-piece loops: nine to fourteen audio_analyze calls and seven list_files calls on a six-piece
 * task). Through a real MCP server and client: targets (pieceIds, pieceFolderId, recursive, the refusals), the
 * grouping against the first piece (sameAsFirst / differsFromFirst / failed, the summary line), the single-piece
 * shape unchanged, and list_files' grouped rows with `perPiece`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { hasFfmpeg } from "@/__tests__/helpers/media";
import { synthMusic, wavBytes } from "@/__tests__/helpers/synth-music";
import { files, folders, pieces } from "@/lib/db/schema/sqlite";
import { diffMeasure, diffReport, groupAnalysis } from "@/mcp/tools/audio-analyze-multi";
import type { MeasureResult } from "@/lib/export/audio-measure";
import type { ReportResult } from "@/lib/export/audio-report";

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

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let testDb: ReturnType<typeof createTestDb>;

async function connect() {
  const server = createLibiMcpServer({ surface: "in-app" });
  const client = new Client({ name: "t", version: "0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const call = (name: string) => async (args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>)[0].text;
    let json: Json = null;
    try { json = JSON.parse(text); } catch { /* plain-text refusal */ }
    return { isError: !!res.isError, text, json };
  };
  return { analyze: call("libi.audio_analyze"), listFiles: call("libi.list_files"), close: async () => { await client.close(); await server.close(); } };
}

const clip = (id: string, fileId: string, over: Record<string, unknown> = {}) => ({ id, kind: "standalone", fileId, startTime: 0, duration: 10, trimStart: 0, volume: 1, enabled: true, ...over });

/** A piece in a folder with its own song file and a manifest holding one bed clip on it. */
function seedCopy(id: string, name: string, folderId: string | null, over: Record<string, unknown> = {}, bytes?: Buffer) {
  seedPiece(testDb, { id, name });
  if (folderId) testDb.update(pieces).set({ folderId }).where(eq(pieces.id, id)).run();
  mkdirSync(join(storageRoot, "storage", id), { recursive: true });
  const data = bytes ?? wavBytes(synthMusic(12, 3));
  writeFileSync(join(storageRoot, "storage", id, "song.wav"), data);
  testDb.insert(files).values({ id: `${id}-song`, pieceId: id, filename: "song.wav", name: "Tidewater Lights", description: "", type: "audio", storagePath: `${id}/song.wav`, contentType: "audio/wav", size: data.length, mediaDuration: 12, hasAudio: true } as never).run();
  writeFileSync(join(storageRoot, "storage", id, "composition.json"), JSON.stringify({ width: 1080, height: 1920, fps: 30, overlays: [], audioClips: [clip(`bed-${id}`, `${id}-song`, over)] }));
}

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "libi-anm-"));
  process.env.LIBI_HOME = storageRoot;
  testDb = createTestDb();
  testDb.insert(folders).values({ id: "fold", name: "Tidewater" }).run();
  testDb.insert(folders).values({ id: "sub", name: "Sub", parentFolderId: "fold" }).run();
  testDb.insert(folders).values({ id: "none", name: "Empty" }).run();
  runJobViaServer.mockReset();
});
afterEach(() => {
  resetTestDb();
  rmSync(storageRoot, { recursive: true, force: true });
  delete process.env.LIBI_HOME;
});

const levels = (lufs: number, over: Record<string, unknown> = {}) => ({ lufs, shortTermMaxLufs: null, rmsDb: lufs - 3, peakDb: lufs + 4, silent: false, ...over });
const range = (from: number, to: number, lufs: number, extra: Record<string, unknown> = {}) => ({ from, to, ...levels(lufs), ...extra });

describe("grouping (pure)", () => {
  const m = (...lufs: number[]): MeasureResult => ({ ranges: lufs.map((l, i) => range(i * 10, i * 10 + 5, l) as never) });
  const outcome = (pieceId: string, name: string, data: MeasureResult) => ({ pieceId, name, result: { ok: true as const, data } });

  it("measure: a match within half a dB collapses to sameAsFirst; a difference names the range and the numbers", () => {
    const g = groupAnalysis([outcome("a", "01", m(-14, -20)), outcome("b", "02", m(-14.3, -20.4)), outcome("c", "03", m(-14, -9))], diffMeasure, "measure");
    expect(g.pieces[0]).toMatchObject({ pieceId: "a", reference: true, ranges: expect.any(Array) });
    expect(g.pieces[1]).toEqual({ pieceId: "b", name: "02", sameAsFirst: true });
    expect(g.pieces[2]).toMatchObject({ pieceId: "c", differsFromFirst: ["range 2 (10-15 s): lufs -9 vs -20, rmsDb -12 vs -23, peakDb -5 vs -16"], ranges: expect.any(Array) });
    expect(g.summary).toContain('2 match piece 1 "01" within 0.5 dB');
    expect(g.summary).toContain('piece 3 "03": range 2 (10-15 s): lufs -9 vs -20, rmsDb -12 vs -23, peakDb -5 vs -16');
  });

  it("measure: silent, null LUFS and a different clip count are differences; all-equal says so in one line", () => {
    const silent = { ranges: [range(0, 5, -90, { lufs: null, rmsDb: -90, peakDb: -90, silent: true }) as never] };
    const g = groupAnalysis([outcome("a", "01", m(-14)), outcome("b", "02", silent)], diffMeasure, "measure");
    expect(g.pieces[1]).toMatchObject({ differsFromFirst: ["range 1 (0-5 s): lufs none vs -14, rmsDb -90 vs -17, peakDb -90 vs -10, silent vs not silent"] });
    const same = groupAnalysis([outcome("a", "01", m(-14)), outcome("b", "02", m(-14)), outcome("c", "03", m(-14))], diffMeasure, "measure");
    expect(same.summary).toBe("measure on 3 pieces: all match piece 1 \"01\" within 0.5 dB.");
    expect(same.pieces.slice(1).every((p) => p.sameAsFirst === true)).toBe(true);
    const withClips = (n: number): MeasureResult => ({ ranges: [range(0, 5, -14, { clips: Array.from({ length: n }, (_, i) => ({ clipId: `c${i}`, ...levels(-18) })) }) as never] });
    expect(diffMeasure(withClips(2), withClips(1))[0]).toMatch(/measures 1 clips vs 2/);
  });

  it("a failed piece keeps its error and never becomes the reference; every piece failing is a failure", () => {
    const fail = (id: string) => ({ pieceId: id, name: id, result: { ok: false as const, error: "measure_failed", message: "boom" } });
    const g = groupAnalysis([fail("a"), outcome("b", "02", m(-14)), outcome("c", "03", m(-14))], diffMeasure, "measure");
    expect(g.reference).toEqual({ pieceId: "b", name: "02" });
    expect(g.pieces[0]).toEqual({ pieceId: "a", name: "a", error: "measure_failed", message: "boom" });
    expect(g.pieces[2]).toMatchObject({ sameAsFirst: true });
    expect(g.summary).toContain("Failed: piece 1 \"a\": boom.");
    const all = groupAnalysis([fail("a"), fail("b")], diffMeasure, "measure");
    expect(all.failedAll).toBe(true);
    expect(all.summary).toMatch(/failed on every piece/);
  });

  it("the summary names at most six differing pieces and two differences each", () => {
    const first = outcome("a", "01", m(-14, -20, -30));
    const others = Array.from({ length: 8 }, (_, i) => outcome(`p${i}`, `0${i + 2}`, m(-1, -2, -3)));
    const g = groupAnalysis([first, ...others], diffMeasure, "measure");
    expect(g.summary).toContain("and 2 more");
    expect(g.summary).toContain(", +");
  });

  const rep = (over: Partial<ReportResult["clips"][number]> = {}, silent = 0): ReportResult => ({
    from: 0,
    to: 4,
    step: 1,
    clips: [{ clipId: "x", fileId: "f", start: 0, end: 4, level: { volume: 1, staticDb: 0 }, t: [0, 1, 2, 3], gainDb: [0, 0, 0, 0], outDb: [0, 0, -12, -12], minDb: -12, maxDb: 0, ...over }],
    ...(silent ? { silentClips: Array.from({ length: silent }, () => ({ clipId: "s", start: 0, end: 1, because: "disabled" })) } : {}),
  });

  it("report: the same curve under other clip ids is the same; a dip that moved, a clip that moved or a silent clip is not", () => {
    expect(diffReport(rep(), rep({ clipId: "other" }))).toEqual([]);
    expect(diffReport(rep(), rep({ outDb: [0, 0, -12.3, -12] }))).toEqual([]);
    expect(diffReport(rep(), rep({ outDb: [0, -12, -12, -12] }))[0]).toMatch(/outDb differs by up to 12 dB at 1 s/);
    expect(diffReport(rep(), rep({ start: 0.5 }))[0]).toMatch(/plays 0.5-4 s vs 0-4 s/);
    expect(diffReport(rep(), rep({}, 1))).toEqual(["1 silent clip(s) vs 0"]);
    expect(diffReport(rep(), rep({ t: [0, 2], gainDb: [0, 0], outDb: [0, -12] }))[0]).toMatch(/sampled differently/);
  });
});

describe("audio_analyze measure over several pieces", () => {
  beforeEach(() => {
    seedCopy("p10", "Tidewater · 10 Last", "fold");
    seedCopy("p02", "Tidewater · 02 Paper", "fold");
    seedCopy("p01", "Tidewater · 01 Neon", "fold");
    seedCopy("deep", "Tidewater · 99 Deep", "sub");
    // Each piece's job answers by its own pieceId: p02 reads 6 dB louder than the others.
    runJobViaServer.mockImplementation(async (_kind: string, params: { pieceId: string }) => ({
      status: "new",
      jobId: `j-${params.pieceId}`,
      clientKey: "k",
      result: { ranges: [range(1, 3, params.pieceId === "p02" ? -8 : -14)] },
    }));
  });

  it("pieceFolderId: one call, one job per piece, in name order with natural numbers (02 before 10), the first in full", async () => {
    const h = await connect();
    const r = await h.analyze({ action: "measure", pieceFolderId: "fold", ranges: [{ from: 1, to: 3 }] });
    expect(r.json.success).toBe(true);
    const d = r.json.data;
    expect(d.pieces.map((p: Json) => p.pieceId)).toEqual(["p01", "p02", "p10"]);
    expect(d.pieces[0]).toMatchObject({ name: "Tidewater · 01 Neon", reference: true, ranges: [{ lufs: -14 }] });
    expect(d.pieces[1]).toMatchObject({ differsFromFirst: [expect.stringMatching(/^range 1 \(1-3 s\): lufs -8 vs -14/)], ranges: [{ lufs: -8 }] });
    expect(d.pieces[2]).toEqual({ pieceId: "p10", name: "Tidewater · 10 Last", sameAsFirst: true });
    expect(d.summary).toContain("2 match piece 1");
    expect(d.summary).toContain('piece 2 "Tidewater · 02 Paper"');
    // every piece asked its own job with its own mix hash, the same ranges
    const asked = runJobViaServer.mock.calls.map((c) => c[1] as { pieceId: string; ranges: unknown; mixHash: string });
    expect(asked.map((a) => a.pieceId).sort()).toEqual(["p01", "p02", "p10"]);
    expect(new Set(asked.map((a) => JSON.stringify(a.ranges))).size).toBe(1);
    expect(runJobViaServer.mock.calls.every((c) => (c[0] as string) === "audio_measure")).toBe(true);
    await h.close();
  });

  it("pieceIds keep the order asked; recursive adds a subfolder's pieces; a cached piece says so", async () => {
    const h = await connect();
    const ids = await h.analyze({ action: "measure", pieceIds: ["p10", "p01"], ranges: [{ from: 1, to: 3 }] });
    expect(ids.json.data.pieces.map((p: Json) => p.pieceId)).toEqual(["p10", "p01"]);
    runJobViaServer.mockClear();
    const rec = await h.analyze({ action: "measure", pieceFolderId: "fold", recursive: true, ranges: [{ from: 1, to: 3 }] });
    expect(rec.json.data.pieces.map((p: Json) => p.pieceId)).toEqual(["p01", "p02", "p10", "deep"]);
    runJobViaServer.mockReset();
    runJobViaServer.mockResolvedValue({ status: "matching_completed", existingJob: { jobId: "j", pieceId: "p01", completedAt: "x", status: "completed", result: { ranges: [range(1, 3, -14)] } } });
    const cached = await h.analyze({ action: "measure", pieceIds: ["p01", "p10"], ranges: [{ from: 1, to: 3 }] });
    expect(cached.json.data.pieces[0].cached).toBe(true);
    expect(cached.json.data.pieces[1]).toMatchObject({ sameAsFirst: true, cached: true });
    await h.close();
  });

  it("a piece that fails is named in the summary and the rest still answer; all failing is an error", async () => {
    runJobViaServer.mockImplementation(async (_k: string, params: { pieceId: string }) => {
      if (params.pieceId === "p02") throw new Error("ffmpeg died");
      return { status: "new", jobId: "j", clientKey: "k", result: { ranges: [range(1, 3, -14)] } };
    });
    const h = await connect();
    const r = await h.analyze({ action: "measure", pieceFolderId: "fold", ranges: [{ from: 1, to: 3 }] });
    expect(r.json.success).toBe(true);
    expect(r.json.data.pieces[1]).toMatchObject({ pieceId: "p02", error: "measure_failed", message: "ffmpeg died" });
    expect(r.json.data.summary).toContain('Failed: piece 2 "Tidewater · 02 Paper": ffmpeg died.');
    runJobViaServer.mockRejectedValue(new Unavailable("down"));
    const all = await h.analyze({ action: "measure", pieceIds: ["p01", "p02"], ranges: [{ from: 1, to: 3 }] });
    expect(all.json).toMatchObject({ success: false, error: "measure_failed" });
    expect(all.json.data.summary).toMatch(/failed on every piece/);
    await h.close();
  });

  it("never runs more than two jobs at once (audio_measure's own limit)", async () => {
    let live = 0;
    let peak = 0;
    runJobViaServer.mockImplementation(async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 15));
      live--;
      return { status: "new", jobId: "j", clientKey: "k", result: { ranges: [range(1, 3, -14)] } };
    });
    const h = await connect();
    await h.analyze({ action: "measure", pieceFolderId: "fold", recursive: true, ranges: [{ from: 1, to: 3 }] });
    expect(peak).toBe(2);
    await h.close();
  });

  it("the single-piece call is unchanged: the job's result as data, no grouping", async () => {
    const h = await connect();
    const r = await h.analyze({ action: "measure", pieceId: "p01", ranges: [{ from: 1, to: 3 }] });
    expect(r.json).toEqual({ success: true, data: { ranges: [range(1, 3, -14)] } });
    expect(r.json.data.pieces).toBeUndefined();
    await h.close();
  });

  it("refuses unusable targets before any job: mixed, none, unknown piece, unknown or empty folder, recursive alone, too many", async () => {
    const h = await connect();
    const ask = async (extra: Record<string, unknown>) => (await h.analyze({ action: "measure", ranges: [{ from: 1, to: 3 }], ...extra })).json;
    expect(await ask({ pieceId: "p01", pieceIds: ["p02"] })).toMatchObject({ success: false, error: "invalid_targets", data: { message: expect.stringMatching(/exactly one of pieceId, pieceIds, pieceFolderId/) } });
    expect((await ask({})).data.message).toMatch(/No target piece/);
    expect((await ask({ pieceIds: ["p01", "ghost"] })).data.message).toMatch(/no such piece ghost/);
    expect((await ask({ pieceFolderId: "nope" })).data.message).toMatch(/no folder nope/);
    expect((await ask({ pieceFolderId: "none" })).data.message).toMatch(/holds no pieces/);
    expect((await ask({ pieceId: "p01", recursive: true })).data.message).toMatch(/recursive only goes with pieceFolderId/);
    const many = await h.analyze({ action: "measure", ranges: [{ from: 1, to: 3 }], pieceIds: Array.from({ length: 25 }, (_, i) => `x${i}`) });
    expect(many.isError).toBe(true);
    expect(runJobViaServer).not.toHaveBeenCalled();
    await h.close();
  });

  it("the advertised fields say where they apply, and the tool's description stays short", async () => {
    const server = createLibiMcpServer({ surface: "in-app" });
    const client = new Client({ name: "t", version: "0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    const tool = (await client.listTools()).tools.find((t) => t.name === "libi.audio_analyze")!;
    const props = (tool.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    expect(props.pieceIds.description).toMatch(/^\(measure, report\)/);
    expect(props.pieceFolderId.description).toMatch(/\(measure, report\)/);
    expect(props.pieceId.description).toMatch(/Required for align/);
    expect(tool.description!.length).toBeLessThan(520);
    await client.close();
    await server.close();
  });
});

const ff = hasFfmpeg() ? describe : describe.skip;

ff("audio_analyze report over several pieces, on real audio", () => {
  beforeEach(() => {
    seedCopy("r1", "Copy 1", "fold");
    seedCopy("r2", "Copy 2", "fold");
    // The third copy's bed carries a -60 dB dip the others do not have.
    seedCopy("r3", "Copy 3", "fold", { volumeKeyframes: { keyframes: [{ t: 0, value: 0 }, { t: 3, value: -60, easing: "linear" }, { t: 6, value: -60 }, { t: 7, value: 0, easing: "linear" }] } });
  });

  it("one call over the folder: identical copies are sameAsFirst, the one with the dip is in full with where it differs", async () => {
    const h = await connect();
    const r = await h.analyze({ action: "report", pieceFolderId: "fold", from: 0, to: 10, step: 1 });
    expect(r.json.success).toBe(true);
    const d = r.json.data;
    expect(d.pieces.map((p: Json) => p.pieceId)).toEqual(["r1", "r2", "r3"]);
    expect(d.pieces[0]).toMatchObject({ reference: true, clips: [{ clipId: "bed-r1" }] });
    expect(d.pieces[1]).toEqual({ pieceId: "r2", name: "Copy 2", sameAsFirst: true });
    expect(d.pieces[2].differsFromFirst[0]).toMatch(/clip 1 (gainDb|outDb) differs by up to/);
    expect(d.pieces[2].clips[0].quiet[0].causes.join(" ")).toMatch(/volume envelope/);
    expect(d.summary).toContain("2 match piece 1");
    await h.close();
  });

  it("the single-piece report is unchanged, and a bad range is refused for the group the same way", async () => {
    const h = await connect();
    const one = await h.analyze({ action: "report", pieceId: "r1", from: 0, to: 10, step: 1 });
    expect(one.json.data.clips[0].clipId).toBe("bed-r1");
    expect(one.json.data.pieces).toBeUndefined();
    const bad = await h.analyze({ action: "report", pieceFolderId: "fold", from: 9, to: 3 });
    expect(bad.json).toMatchObject({ success: false, error: "report_failed" });
    expect(bad.json.data.summary).toMatch(/not valid/);
    await h.close();
  });
});

describe("list_files over several pieces", () => {
  const addAudio = (pieceId: string, id: string, name: string) =>
    testDb.insert(files).values({ id, pieceId, filename: `${id}.wav`, name, description: "", type: "audio", storagePath: `${pieceId}/${id}.wav`, contentType: "audio/wav", size: 10, mediaDuration: 11, hasAudio: true } as never).run();

  beforeEach(() => {
    seedCopy("p10", "Tidewater · 10 Last", "fold");
    seedCopy("p02", "Tidewater · 02 Paper", "fold");
    seedCopy("p01", "Tidewater · 01 Neon", "fold");
    addAudio("p01", "p01-narr", "Narration");
    seedCopy("deep", "Tidewater · 99 Deep", "sub");
  });

  it("pieceFolderId: ONE call, grouped by piece in name order, compact rows (no storage path)", async () => {
    const h = await connect();
    const r = await h.listFiles({ pieceFolderId: "fold" });
    expect(r.json.success).toBe(true);
    const d = r.json.data;
    expect(d.pieces.map((p: Json) => p.pieceId)).toEqual(["p01", "p02", "p10"]);
    expect(d.pieces[0].name).toBe("Tidewater · 01 Neon");
    expect(d.pieces[0].files.map((f: Json) => f.name).sort()).toEqual(["Narration", "Tidewater Lights"]);
    expect(d.pieces[1].files).toEqual([expect.objectContaining({ id: "p02-song", name: "Tidewater Lights", type: "audio", mediaDuration: 12, hasAudio: true })]);
    expect(JSON.stringify(d)).not.toMatch(/storagePath/);
    expect(d.perPiece).toBeUndefined(); // no query: nothing to pick
    expect(d.files).toBeUndefined();
    await h.close();
  });

  it("with a query that finds one file in each piece it hands back perPiece, ready for an apply_ops op", async () => {
    const h = await connect();
    const r = await h.listFiles({ pieceFolderId: "fold", query: "tidewater" });
    expect(r.json.data.perPiece).toEqual({ p01: { fileId: "p01-song" }, p02: { fileId: "p02-song" }, p10: { fileId: "p10-song" } });
    expect(r.json.data.note).toBeUndefined();
    const ids = await h.listFiles({ pieceIds: ["p10", "p02"], query: "Tidewater Lights" });
    expect(Object.keys(ids.json.data.perPiece)).toEqual(["p10", "p02"]);
    await h.close();
  });

  it("when a piece has none or several matches there is no perPiece, and the note says which", async () => {
    addAudio("p02", "p02-song2", "Tidewater Lights (alt)");
    const h = await connect();
    const several = await h.listFiles({ pieceFolderId: "fold", query: "Tidewater" });
    expect(several.json.data.perPiece).toBeUndefined();
    expect(several.json.data.note).toMatch(/Tidewater · 02 Paper has 2/);
    const none = await h.listFiles({ pieceIds: ["p01", "p10"], query: "narration" });
    expect(none.json.data.perPiece).toBeUndefined();
    expect(none.json.data.note).toMatch(/Tidewater · 10 Last has 0/);
    await h.close();
  });

  it("recursive adds subfolders; targets are refused like upload_file's; scope other than piece is refused", async () => {
    const h = await connect();
    expect((await h.listFiles({ pieceFolderId: "fold", recursive: true })).json.data.pieces.map((p: Json) => p.pieceId)).toEqual(["p01", "p02", "p10", "deep"]);
    expect((await h.listFiles({ pieceFolderId: "fold", pieceIds: ["p01"] })).json.error).toMatch(/exactly one of pieceId, pieceIds, pieceFolderId/);
    expect((await h.listFiles({ pieceIds: ["p01", "ghost"] })).json.error).toMatch(/no such piece ghost/);
    expect((await h.listFiles({ pieceFolderId: "none" })).json.error).toMatch(/holds no pieces/);
    expect((await h.listFiles({ pieceFolderId: "fold", scope: "all" })).json.error).toMatch(/leave scope out/);
    expect((await h.listFiles({ pieceId: "p01", recursive: true })).json.error).toMatch(/recursive only goes with pieceFolderId/);
    await h.close();
  });

  it("the single-piece listing is unchanged (full rows, `files`), and its missing-target error points at the multi form", async () => {
    const h = await connect();
    const one = await h.listFiles({ pieceId: "p01" });
    expect(one.json.data.pieces).toBeUndefined();
    expect(one.json.data.files.map((f: Json) => f.id).sort()).toEqual(["p01-narr", "p01-song"]);
    expect(one.json.data.files[0].storagePath).toBeTruthy();
    const none = await h.listFiles({});
    expect(none.json.error).toMatch(/pieceId is required when scope is 'piece'.*pieceFolderId/);
    expect((await h.listFiles({ pieceId: "p01", query: "narr" })).json.data.files).toHaveLength(1);
    await h.close();
  });
});
