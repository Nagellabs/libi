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
vi.mock("@/lib/render/frame-capture", () => ({
  renderCompositionFrames: (...a: unknown[]) => renderCompositionFrames(...a),
}));

const loadComposition = vi.fn();
vi.mock("@/lib/composition/persistence", () => ({
  loadComposition: (...a: unknown[]) => loadComposition(...a),
}));

import { POST } from "@/app/api/render/frames/route";

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
    renderCompositionFrames.mockResolvedValue(times.map((t, i) => ({ time: t, path: paths[i] })));
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
    renderCompositionFrames.mockResolvedValue([{ time: 0, path: p }]);
    loadComposition.mockResolvedValue({ manifest: { overlays: [] }, scenes: [] });

    const res = await POST(jsonReq({ pieceId: "p1", atTimes: [0] }));
    const json = await res.json();
    expect(json.contactSheet).toBeUndefined();
  });
});

describe("POST /api/render/frames — unresolvedFonts", () => {
  it("is always present, empty when every live font resolves", async () => {
    const p = await writeTestFrame("solo.png");
    renderCompositionFrames.mockResolvedValue([{ time: 0, path: p }]);
    loadComposition.mockResolvedValue({
      manifest: { overlays: [textOverlay("t1", "48px Inter", 0, 4)] },
    });

    const res = await POST(jsonReq({ pieceId: "p1", atTimes: [0] }));
    const json = await res.json();
    expect(json.unresolvedFonts).toEqual([]);
  });

  it("reports a ghost family used by an overlay live at a requested time", async () => {
    const p = await writeTestFrame("solo.png");
    renderCompositionFrames.mockResolvedValue([{ time: 1, path: p }]);
    loadComposition.mockResolvedValue({
      manifest: { overlays: [textOverlay("t1", "48px GhostFamilyLive", 0, 4)] },
    });

    const res = await POST(jsonReq({ pieceId: "p1", atTimes: [1] }));
    const json = await res.json();
    expect(json.unresolvedFonts).toEqual(["GhostFamilyLive"]);
  });

  it("does not report a ghost family only used outside the requested times", async () => {
    const p = await writeTestFrame("solo.png");
    renderCompositionFrames.mockResolvedValue([{ time: 1, path: p }]);
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
