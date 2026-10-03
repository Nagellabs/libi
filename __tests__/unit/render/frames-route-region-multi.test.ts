/**
 * `POST /api/render/frames` — `region`, `maxEdge` and `pieceIds` (agent-speed B8). Chromium and the manifest
 * storage are mocked (as in frames-contact-sheet.test.ts); the canvas and the database are real, because the
 * point is the bytes that come back: a crop with the right pixels, a sheet that fits its edge, labels for
 * pieces named in the database.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";

const renderCompositionFrames = vi.fn();
vi.mock("@/lib/render/frame-capture", async () => ({
  renderCompositionFrames: (...a: unknown[]) => renderCompositionFrames(...a),
  FrameTimesOutOfRangeError: (await vi.importActual<typeof import("@/lib/render/frame-capture")>("@/lib/render/frame-capture"))
    .FrameTimesOutOfRangeError,
}));
const loadComposition = vi.fn();
vi.mock("@/lib/composition/persistence", () => ({ loadComposition: (...a: unknown[]) => loadComposition(...a) }));
vi.mock("@/lib/overlays/code-files", () => ({ overlayCodeFilePath: async (_p: string, o: { id: string }) => `/abs/${o.id}/draw.jsx` }));

import { POST } from "@/app/api/render/frames/route";
import { FrameTimesOutOfRangeError } from "@/lib/render/frame-capture";
import { __resetRenderDiagnosticsForTests, mergeRenderDiagnostics } from "@/lib/render/render-diagnostics-store";
import { bodyHashesOf } from "@/lib/render/body-hashes";

// The composition is 1080x1920; frames are rendered at 540x960 (half), as the verify render does.
const COMP = { width: 1080, height: 1920, fps: 30 };
const FRAME_W = 540;
const FRAME_H = 960;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "libi-frames-region-"));
  renderCompositionFrames.mockReset();
  loadComposition.mockReset();
  __resetRenderDiagnosticsForTests();
  createTestDb();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetTestDb();
});

/** A dark frame with a red block at composition (100..300, 1500..1600), i.e. render (50..150, 750..800). */
async function writeFrame(name: string, opts: { red?: boolean } = { red: true }): Promise<string> {
  const c = createCanvas(FRAME_W, FRAME_H);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#101820";
  ctx.fillRect(0, 0, FRAME_W, FRAME_H);
  if (opts.red !== false) {
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(50, 750, 100, 50);
  }
  const p = path.join(dir, name);
  await fs.writeFile(p, await c.encode("png"));
  return p;
}
const captured = (time: number, p: string) => ({ time, frame: Math.round(time * 30), frameTime: time, path: p });
const req = (body: unknown) =>
  new Request("http://x/api/render/frames", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("region", () => {
  it("returns the crop as the frame's path, with the pixels of that rectangle, and renders bigger to read it", async () => {
    const p = await writeFrame("f.png");
    renderCompositionFrames.mockResolvedValue([captured(1, p)]);
    loadComposition.mockResolvedValue({ manifest: { ...COMP, overlays: [] } });

    const res = await POST(req({ pieceId: "p1", atTimes: [1], region: { x: 100, y: 1500, width: 200, height: 100 } }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.region).toEqual({ x: 100, y: 1500, width: 200, height: 100 });
    expect(json.regionClipped).toBeUndefined();
    const out = json.frames[0].path as string;
    expect(out).not.toBe(p);
    const img = await loadImage(await fs.readFile(out));
    expect([img.width, img.height]).toEqual([100, 50]); // composition px x the render's 0.5
    const probe = createCanvas(img.width, img.height);
    probe.getContext("2d").drawImage(img, 0, 0);
    const px = probe.getContext("2d").getImageData(50, 25, 1, 1).data;
    expect([px[0], px[1], px[2]]).toEqual([255, 0, 0]);
    // the original is still there, untouched
    expect((await loadImage(await fs.readFile(p))).width).toBe(FRAME_W);
    // a small region asks the render for a bigger frame than the default 720 short side
    expect(renderCompositionFrames.mock.calls[0][2]).toMatchObject({ maxShortSide: 1080 });
  });

  it("flags `blank` about the crop, not the whole frame", async () => {
    const p = await writeFrame("f.png"); // the red block is NOT inside this region
    renderCompositionFrames.mockResolvedValue([captured(1, p)]);
    loadComposition.mockResolvedValue({ manifest: { ...COMP, overlays: [] } });
    const json = await (await POST(req({ pieceId: "p1", atTimes: [1], region: { x: 600, y: 100, width: 300, height: 300 } }))).json();
    expect(json.frames[0].blank).toBe(true);
  });

  it("cuts a region that runs off the composition and says so; refuses one wholly outside", async () => {
    const p = await writeFrame("f.png");
    renderCompositionFrames.mockResolvedValue([captured(1, p)]);
    loadComposition.mockResolvedValue({ manifest: { ...COMP, overlays: [] } });
    const cut = await (await POST(req({ pieceId: "p1", atTimes: [1], region: { x: 1000, y: 1800, width: 500, height: 500 } }))).json();
    expect(cut.region).toEqual({ x: 1000, y: 1800, width: 80, height: 120 });
    expect(cut.regionClipped).toBe(true);

    const out = await POST(req({ pieceId: "p1", atTimes: [1], region: { x: 5000, y: 0, width: 10, height: 10 } }));
    expect(out.status).toBe(400);
    expect((await out.json()).error).toMatch(/outside the composition \(1080x1920\)/);
  });

  it("refuses a malformed region or maxEdge before rendering anything", async () => {
    expect((await POST(req({ pieceId: "p1", atTimes: [1], region: { x: 0, y: 0, width: 0, height: 5 } }))).status).toBe(400);
    expect((await POST(req({ pieceId: "p1", atTimes: [1], maxEdge: 10 }))).status).toBe(400);
    expect(renderCompositionFrames).not.toHaveBeenCalled();
  });
});

describe("maxEdge", () => {
  it("a sheet defaults to a 1024 long edge, and maxEdge changes it", async () => {
    const times = [0, 1, 2, 3];
    const paths = await Promise.all(times.map((_, i) => writeFrame(`f${i}.png`)));
    renderCompositionFrames.mockResolvedValue(times.map((t, i) => captured(t, paths[i])));
    loadComposition.mockResolvedValue({ manifest: { ...COMP, overlays: [] } });

    const dflt = await (await POST(req({ pieceId: "p1", atTimes: times, contactSheet: true }))).json();
    const a = await loadImage(await fs.readFile(dflt.contactSheet));
    expect(Math.max(a.width, a.height)).toBeLessThanOrEqual(1024);
    expect(Math.max(a.width, a.height)).toBeGreaterThan(800);

    const small = await (await POST(req({ pieceId: "p1", atTimes: times, contactSheet: true, maxEdge: 512 }))).json();
    const b = await loadImage(await fs.readFile(small.contactSheet));
    expect(Math.max(b.width, b.height)).toBeLessThanOrEqual(512);
    // frames come back at full size unless a cap was asked for; with one, each file honours it
    expect(dflt.frames[0].path).toBe(paths[0]);
    const capped = await loadImage(await fs.readFile(small.frames[0].path));
    expect(Math.max(capped.width, capped.height)).toBeLessThanOrEqual(512);
  });
});

describe("pieceIds: one labelled sheet across pieces", () => {
  async function setup(ids: string[]) {
    const db = createTestDb();
    ids.forEach((id, i) => seedPiece(db, { id, name: `Dreams 0${i + 1}` }));
    loadComposition.mockResolvedValue({ manifest: { ...COMP, overlays: [] } });
  }

  it("renders the same times of each piece into ONE sheet; the result maps labels to pieces", async () => {
    await setup(["pa", "pb", "pc"]);
    const calls: string[] = [];
    renderCompositionFrames.mockImplementation(async (pieceId: string, times: number[]) => {
      calls.push(pieceId);
      return Promise.all(times.map(async (t) => captured(t, await writeFrame(`${pieceId}-${t}.png`))));
    });
    const res = await POST(req({ pieceIds: ["pa", "pb", "pc"], atTimes: [0.5, 2] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(calls).toEqual(["pa", "pb", "pc"]); // in order, one at a time
    expect(json.pieces).toEqual([
      { label: "P1", pieceId: "pa", name: "Dreams 01" },
      { label: "P2", pieceId: "pb", name: "Dreams 02" },
      { label: "P3", pieceId: "pc", name: "Dreams 03" },
    ]);
    expect(json.frames).toHaveLength(6);
    expect(json.frames[0]).toMatchObject({ piece: "P1", time: 0.5, frame: 15 });
    expect(json.frames[0]).not.toHaveProperty("overflow");
    expect(json.unresolvedFonts).toEqual([]);
    expect(json.renderDiagnostics).toEqual([]);
    const sheet = await loadImage(await fs.readFile(json.contactSheet));
    expect(Math.max(sheet.width, sheet.height)).toBeLessThanOrEqual(1024);
    // tall frames, 3 pieces x 2 times: the sheet is not a sliver
    expect(Math.min(sheet.width, sheet.height)).toBeGreaterThan(400);
  });

  it("carries each piece's body failures with its label and pieceId", async () => {
    await setup(["pa", "pb"]);
    const ov = { id: "heart", kind: "code", drawFunction: "ctx.fillStyle = heart;", startTime: 0, duration: 4, z: 1, opacity: 1, rect: { x: 0, y: 0, width: 100, height: 40 } };
    loadComposition.mockImplementation(async (id: string) => ({ manifest: { ...COMP, overlays: id === "pb" ? [ov] : [] } }));
    renderCompositionFrames.mockImplementation(async (pieceId: string, times: number[]) =>
      Promise.all(times.map(async (t) => captured(t, await writeFrame(`${pieceId}.png`)))),
    );
    const hash = (await bodyHashesOf([ov as never])).get("heart")!;
    mergeRenderDiagnostics("pb", [{ overlayId: "heart", kind: "code", phase: "render", message: "heart is not defined", time: 1, frame: 30, at: 5, sourceHash: hash }]);
    const json = await (await POST(req({ pieceIds: ["pa", "pb"], atTimes: [1] }))).json();
    expect(json.renderDiagnostics).toEqual([expect.objectContaining({ overlayId: "heart", pieceId: "pb", piece: "P2", message: "heart is not defined" })]);
  });

  it("a piece too short for a time says so and leaves an empty cell; the others still render", async () => {
    await setup(["pa", "pb"]);
    renderCompositionFrames.mockImplementation(async (pieceId: string, times: number[]) => {
      if (pieceId === "pb") throw new FrameTimesOutOfRangeError(times, 30, 90);
      return Promise.all(times.map(async (t) => captured(t, await writeFrame(`${pieceId}.png`))));
    });
    const res = await POST(req({ pieceIds: ["pa", "pb"], atTimes: [5] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pieces[1]).toMatchObject({ label: "P2", pieceId: "pb", lastValidTime: 2.967 });
    expect(json.pieces[1].error).toMatch(/at or past the end/);
    expect(json.frames.map((f: { piece: string }) => f.piece)).toEqual(["P1"]);
    expect(json.failed).toBe(1);
    expect(typeof json.contactSheet).toBe("string");
  });

  it("every piece failing is a 400 naming each", async () => {
    await setup(["pa", "pb"]);
    renderCompositionFrames.mockImplementation(async (_p: string, times: number[]) => {
      throw new FrameTimesOutOfRangeError(times, 30, 90);
    });
    const res = await POST(req({ pieceIds: ["pa", "pb"], atTimes: [5] }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.errors.map((e: { pieceId: string }) => e.pieceId)).toEqual(["pa", "pb"]);
  });

  it("refuses what cannot make a readable sheet, before rendering anything", async () => {
    await setup(["pa", "pb"]);
    const ids = Array.from({ length: 9 }, (_, i) => `p${i}`);
    expect((await (await POST(req({ pieceIds: ids, atTimes: [1] }))).json()).error).toMatch(/at most 8/);
    expect((await (await POST(req({ pieceIds: ["pa", "pb"] }))).json()).error).toMatch(/Provide atTimes/);
    expect((await (await POST(req({ pieceIds: ["pa", "pb"], overlayId: "x" }))).json()).error).toMatch(/overlayId belongs to one piece/);
    expect((await (await POST(req({ pieceIds: ["pa", "pb", "pc", "pd", "pe", "pf", "pg"], atTimes: [0, 1, 2, 3] }))).json()).error).toMatch(/at most 24/);
    expect((await (await POST(req({ pieceIds: ["pa", "pa"], atTimes: [1] }))).json()).error).toMatch(/same piece twice/);
    expect(renderCompositionFrames).not.toHaveBeenCalled();
  });

  it("a piece that does not exist is reported, not rendered", async () => {
    await setup(["pa"]);
    renderCompositionFrames.mockImplementation(async (pieceId: string, times: number[]) =>
      Promise.all(times.map(async (t) => captured(t, await writeFrame(`${pieceId}.png`)))),
    );
    const json = await (await POST(req({ pieceIds: ["pa", "ghost"], atTimes: [1] }))).json();
    expect(json.pieces[1]).toMatchObject({ pieceId: "ghost", error: "piece_not_found" });
    expect(renderCompositionFrames).toHaveBeenCalledTimes(1);
  });

  it("applies region to every piece's frames", async () => {
    await setup(["pa", "pb"]);
    renderCompositionFrames.mockImplementation(async (pieceId: string, times: number[]) =>
      Promise.all(times.map(async (t) => captured(t, await writeFrame(`${pieceId}.png`)))),
    );
    const json = await (await POST(req({ pieceIds: ["pa", "pb"], atTimes: [1], region: { x: 100, y: 1500, width: 200, height: 100 } }))).json();
    for (const f of json.frames) {
      const img = await loadImage(await fs.readFile(f.path));
      expect([img.width, img.height]).toEqual([100, 50]);
    }
  });
});
