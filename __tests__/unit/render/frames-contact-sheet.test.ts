/**
 * `POST /api/render/frames` — contact sheet + font report (Task 3 of
 * docs-local/plans/2026-08-18-agent-visual-authoring.md).
 *
 * The heavy dependencies (Chromium render, manifest storage) are mocked so
 * this stays a fast unit test; `@napi-rs/canvas` itself is real, since the
 * whole point of this test is verifying real image bytes come back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const renderCompositionFrames = vi.fn();
vi.mock("@/lib/render/frame-capture", async () => ({
  renderCompositionFrames: (...a: unknown[]) => renderCompositionFrames(...a),
  FrameTimesOutOfRangeError: (await vi.importActual<typeof import("@/lib/render/frame-capture")>("@/lib/render/frame-capture"))
    .FrameTimesOutOfRangeError,
}));

/** What renderCompositionFrames returns for a time that lands on its own frame (30 fps). */
const captured = (time: number, p: string) => ({ time, frame: Math.round(time * 30), frameTime: time, path: p });

const loadComposition = vi.fn();
vi.mock("@/lib/composition/persistence", () => ({
  loadComposition: (...a: unknown[]) => loadComposition(...a),
}));

import { POST } from "@/app/api/render/frames/route";
import { __resetRenderDiagnosticsForTests, mergeRenderDiagnostics } from "@/lib/render/render-diagnostics-store";
import { bodyHashesOf } from "@/lib/render/body-hashes";
vi.mock("@/lib/overlays/code-files", () => ({
  overlayCodeFilePath: async (_pieceId: string, o: { id: string }) => `/abs/${o.id}/draw.jsx`,
}));

const FRAME_W = 320;
const FRAME_H = 180;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "libi-contact-sheet-"));
  renderCompositionFrames.mockReset();
  loadComposition.mockReset();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function writeTestFrame(name: string): Promise<string> {
  const canvas = createCanvas(FRAME_W, FRAME_H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#336699";
  ctx.fillRect(0, 0, FRAME_W, FRAME_H);
  const buf = await canvas.encode("png");
  const p = path.join(dir, name);
  await fs.writeFile(p, buf);
  return p;
}

function textOverlay(id: string, font: string, startTime: number, duration: number) {
  return {
    id,
    kind: "text" as const,
    content: id,
    font,
    color: "#fff",
    align: "left" as const,
    startTime,
    duration,
    z: 1,
    rect: { x: 0, y: 0, width: 100, height: 40 },
  };
}

function jsonReq(body: unknown): Request {
  return new Request("http://x/api/render/frames", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/render/frames — contact sheet", () => {
  it("returns a labelled JPEG grid wider than a single frame, for 4 requested times", async () => {
    const times = [0, 1, 2, 3];
    const paths = await Promise.all(times.map((_, i) => writeTestFrame(`frame-${i}.png`)));
    renderCompositionFrames.mockResolvedValue(times.map((t, i) => captured(t, paths[i])));
    loadComposition.mockResolvedValue({ manifest: { overlays: [] }, scenes: [] });

    const res = await POST(jsonReq({ pieceId: "p1", atTimes: times, contactSheet: true }));
    expect(res.status).toBe(200);
    const json = await res.json();

    // Per-frame entries and overflow keep working exactly as before.
    expect(json.frames).toHaveLength(4);
    for (const f of json.frames) {
      expect(f.overflow).toHaveProperty("touchesEdge");
    }

    expect(typeof json.contactSheet).toBe("string");
    const sheetBuf = await fs.readFile(json.contactSheet as string);
    // JPEG magic bytes (SOI marker).
    expect(sheetBuf[0]).toBe(0xff);
    expect(sheetBuf[1]).toBe(0xd8);

    const sheetImg = await loadImage(sheetBuf);
    expect(sheetImg.width).toBeGreaterThan(FRAME_W);
  });

  it("omits contactSheet when not requested", async () => {
    const p = await writeTestFrame("solo.png");
    renderCompositionFrames.mockResolvedValue([captured(0, p)]);
    loadComposition.mockResolvedValue({ manifest: { overlays: [] }, scenes: [] });

    const res = await POST(jsonReq({ pieceId: "p1", atTimes: [0] }));
    const json = await res.json();
    expect(json.contactSheet).toBeUndefined();
  });
});

describe("POST /api/render/frames — unresolvedFonts", () => {
  it("is always present, empty when every live font resolves", async () => {
    const p = await writeTestFrame("solo.png");
    renderCompositionFrames.mockResolvedValue([captured(0, p)]);
    loadComposition.mockResolvedValue({
      manifest: { overlays: [textOverlay("t1", "48px Inter", 0, 4)] },
    });

    const res = await POST(jsonReq({ pieceId: "p1", atTimes: [0] }));
    const json = await res.json();
    expect(json.unresolvedFonts).toEqual([]);
  });

  it("reports a ghost family used by an overlay live at a requested time", async () => {
    const p = await writeTestFrame("solo.png");
    renderCompositionFrames.mockResolvedValue([captured(1, p)]);
    loadComposition.mockResolvedValue({
      manifest: { overlays: [textOverlay("t1", "48px GhostFamilyLive", 0, 4)] },
    });

    const res = await POST(jsonReq({ pieceId: "p1", atTimes: [1] }));
    const json = await res.json();
    expect(json.unresolvedFonts).toEqual(["GhostFamilyLive"]);
  });

  it("does not report a ghost family only used outside the requested times", async () => {
    const p = await writeTestFrame("solo.png");
    renderCompositionFrames.mockResolvedValue([captured(1, p)]);
    loadComposition.mockResolvedValue({
      manifest: {
        overlays: [
          textOverlay("live", "48px Inter", 0, 4),
          textOverlay("ghost-out-of-range", "48px GhostFamilyOffscreen", 100, 4),
        ],
      },
    });

    const res = await POST(jsonReq({ pieceId: "p1", atTimes: [1] }));
    const json = await res.json();
    expect(json.unresolvedFonts).toEqual([]);
  });
});

describe("POST /api/render/frames — the frame each time drew (Task 12b re-review 2)", () => {
  it("N1: every entry names the absolute frame it drew", async () => {
    const p = await writeTestFrame("f2.png");
    renderCompositionFrames.mockResolvedValue([{ time: 0.067, frame: 2, frameTime: 2 / 30, path: p }]);
    loadComposition.mockResolvedValue({ manifest: { overlays: [] } });

    const json = await (await POST(jsonReq({ pieceId: "p1", atTimes: [0.067] }))).json();
    expect(json.frames).toEqual([expect.objectContaining({ time: 0.067, frame: 2, path: p })]);
  });

  it("N2: a time past the end is a 400 naming, per time, the duration and the last valid time", async () => {
    const { FrameTimesOutOfRangeError } = await import("@/lib/render/frame-capture");
    renderCompositionFrames.mockRejectedValue(new FrameTimesOutOfRangeError([5, 60], 30, 150));
    loadComposition.mockResolvedValue({ manifest: { overlays: [] } });

    const res = await POST(jsonReq({ pieceId: "p1", atTimes: [1, 5, 60] }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.duration).toBe(5);
    expect(json.lastValidTime).toBe(4.967);
    expect(json.errors.map((e: { time: number }) => e.time)).toEqual([5, 60]);
    expect(json.error).toContain("4.967");
  });

  it("N2: fonts are checked at the time of the frame actually drawn, not the time asked for", async () => {
    const p = await writeTestFrame("last.png");
    // 4.99 s on a 150-frame piece draws frame 149, at 4.9667 s.
    renderCompositionFrames.mockResolvedValue([{ time: 4.99, frame: 149, frameTime: 149 / 30, path: p }]);
    loadComposition.mockResolvedValue({
      manifest: {
        overlays: [
          // On screen at frame 149 but not at 4.99.
          textOverlay("drawn", "48px GhostOnDrawnFrame", 4.9, 0.08),
          // Live at 4.99 but not on frame 149.
          textOverlay("asked", "48px GhostOnlyAtAskedTime", 4.98, 0.02),
        ],
      },
    });

    const json = await (await POST(jsonReq({ pieceId: "p1", atTimes: [4.99] }))).json();
    expect(json.unresolvedFonts).toEqual(["GhostOnDrawnFrame"]);
  });
});

describe("POST /api/render/frames — body failures and blank frames (agent-speed A2)", () => {
  async function writeFlatFrame(name: string): Promise<string> {
    const canvas = createCanvas(FRAME_W, FRAME_H);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, FRAME_W, FRAME_H);
    const p = path.join(dir, name);
    await fs.writeFile(p, await canvas.encode("png"));
    return p;
  }

  function codeOverlay(id: string, startTime: number, duration: number) {
    return {
      id,
      kind: "code" as const,
      drawFunction: "ctx.fillStyle = heart;",
      startTime,
      duration,
      z: 1,
      opacity: 1,
      rect: { x: 0, y: 0, width: 100, height: 40 },
    };
  }

  beforeEach(() => __resetRenderDiagnosticsForTests());

  it("flags an empty frame `blank: true` and leaves a drawn frame unflagged", async () => {
    const flat = await writeFlatFrame("flat.png");
    const drawn = await writeTestFrame("drawn.png"); // one flat #336699 too: paint something on it
    const canvas = createCanvas(FRAME_W, FRAME_H);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, FRAME_W, FRAME_H);
    ctx.fillStyle = "#fff";
    ctx.fillRect(60, 60, 200, 60);
    await fs.writeFile(drawn, await canvas.encode("png"));
    renderCompositionFrames.mockResolvedValue([captured(0, flat), captured(1, drawn)]);
    loadComposition.mockResolvedValue({ manifest: { overlays: [] } });

    const json = await (await POST(jsonReq({ pieceId: "p1", atTimes: [0, 1] }))).json();
    expect(json.frames[0].blank).toBe(true);
    expect(json.frames[1].blank).toBeUndefined();
  });

  it("returns the body failure of an overlay drawn on the frames, with its code file; always an array", async () => {
    const p = await writeFlatFrame("f.png");
    const ov = codeOverlay("heart", 0, 4);
    renderCompositionFrames.mockResolvedValue([captured(1, p)]);
    loadComposition.mockResolvedValue({ manifest: { overlays: [ov] } });

    const clean = await (await POST(jsonReq({ pieceId: "p1", atTimes: [1] }))).json();
    expect(clean.renderDiagnostics).toEqual([]);

    const hash = (await bodyHashesOf([ov as never])).get("heart")!;
    mergeRenderDiagnostics("p1", [
      { overlayId: "heart", kind: "code", phase: "render", message: "heart is not defined", time: 1, frame: 30, at: 5, sourceHash: hash },
      // a failure on another frame this pass did not draw
      { overlayId: "gone", kind: "code", phase: "render", message: "x", frame: 3, at: 5 },
    ]);
    const json = await (await POST(jsonReq({ pieceId: "p1", atTimes: [1] }))).json();
    expect(json.renderDiagnostics).toEqual([
      expect.objectContaining({ overlayId: "heart", phase: "render", message: "heart is not defined", frame: 30 }),
    ]);
  });

  it("a failure recorded against a body the agent has since replaced is not reported", async () => {
    const p = await writeFlatFrame("f.png");
    const ov = codeOverlay("heart", 0, 4);
    renderCompositionFrames.mockResolvedValue([captured(1, p)]);
    loadComposition.mockResolvedValue({ manifest: { overlays: [ov] } });
    mergeRenderDiagnostics("p1", [
      { overlayId: "heart", kind: "code", phase: "render", message: "old", frame: 30, at: 5, sourceHash: "an-older-body" },
    ]);
    const json = await (await POST(jsonReq({ pieceId: "p1", atTimes: [1] }))).json();
    expect(json.renderDiagnostics).toEqual([]);
  });

  it("a snapshot render reports no draft diagnostics", async () => {
    const p = await writeFlatFrame("f.png");
    const ov = codeOverlay("heart", 0, 4);
    renderCompositionFrames.mockResolvedValue([captured(1, p)]);
    loadComposition.mockResolvedValue({ manifest: { overlays: [ov] } });
    const hash = (await bodyHashesOf([ov as never])).get("heart")!;
    mergeRenderDiagnostics("p1", [
      { overlayId: "heart", kind: "code", phase: "render", message: "x", frame: 30, at: 5, sourceHash: hash },
    ]);
    const json = await (await POST(jsonReq({ pieceId: "p1", atTimes: [1], source: "snapshot" }))).json();
    expect(json.renderDiagnostics).toEqual([]);
  });
});
