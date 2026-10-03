/**
 * libi.render_overlay_frames shows a broken body (agent-speed A2). The real
 * seam, end to end except Chromium: the render page's postback
 * (`/api/export/render-result`) files the failure, and the frames route
 * (`/api/render/frames`) hands it back with the frames it drew. A body that
 * throws "heart is not defined" draws nothing, so the frame is blank as well.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { sha256Hex } from "@/lib/sandbox/hash";

const BODY = "ctx.fillStyle = heart;";
const overlay = {
  id: "heart",
  kind: "code",
  drawFunction: BODY,
  startTime: 0,
  duration: 4,
  z: 1,
  opacity: 1,
  rect: { x: 0, y: 0, width: 100, height: 40 },
};
const manifest = { width: 320, height: 180, fps: 30, overlays: [overlay] };

vi.mock("@/lib/composition/persistence", () => ({
  hasManifest: async () => true,
  loadManifest: async () => manifest,
  loadComposition: async () => ({ manifest, legacyScenes: 0 }),
}));
vi.mock("@/lib/overlays/code-files", () => ({
  overlayCodeFilePath: async (_p: string, o: { id: string }) => `/abs/${o.id}/draw.jsx`,
}));

const frameCapture = vi.hoisted(() => ({ run: null as null | ((times: number[]) => Promise<unknown[]>) }));
vi.mock("@/lib/render/frame-capture", async () => ({
  renderCompositionFrames: (_pieceId: string, times: number[]) => frameCapture.run!(times),
  FrameTimesOutOfRangeError: (await vi.importActual<typeof import("@/lib/render/frame-capture")>("@/lib/render/frame-capture"))
    .FrameTimesOutOfRangeError,
}));

import { createRenderJob } from "@/lib/export/render-jobs";
import { POST as postResult } from "@/app/api/export/render-result/route";
import { POST as renderFrames } from "@/app/api/render/frames/route";
import { __resetRenderDiagnosticsForTests } from "@/lib/render/render-diagnostics-store";

const RENDER_PAGE = { host: "127.0.0.1:3461", origin: "http://127.0.0.1:3461", "sec-fetch-site": "same-origin" };

/** What the Chromium backend does for the route: render, post the page's
 *  diagnostics report, return the frames. */
async function fakeBackendPass(times: number[], failure: boolean, dir: string) {
  const job = createRenderJob({
    pieceId: "p1",
    payload: { overlays: [], audioClips: [], width: 320, height: 180, fps: 30, files: [] },
    settings: { format: "mp4", codec: "avc", bitrate: 1, width: 320, height: 180, fps: 30 },
  });
  const hash = await sha256Hex(BODY);
  const fd = new FormData();
  fd.append("jobId", job.jobId);
  fd.append("token", job.token);
  fd.append("durationSeconds", "1");
  fd.append(
    "renderDiagnostics",
    JSON.stringify({
      fps: 30,
      diagnostics: failure
        ? [{ overlayId: "heart", kind: "code", phase: "render", message: "heart is not defined", line: 1, column: 20, time: 1, frame: 30, sourceHash: hash, at: 9 }]
        : [],
      unattributed: [],
      clean: failure ? [] : [{ overlayId: "heart", sourceHash: hash, frames: [[0, 120]] }],
    }),
  );
  fd.append("file", new Blob([new Uint8Array([0])]), "out.mp4");
  const res = await postResult(new Request("http://127.0.0.1:3461/api/export/render-result", { method: "POST", body: fd, headers: RENDER_PAGE }));
  expect(res.status).toBe(200);
  await job.done;

  const canvas = createCanvas(320, 180);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 320, 180);
  if (!failure) {
    ctx.fillStyle = "#f00";
    ctx.fillRect(100, 60, 120, 60);
  }
  const p = path.join(dir, `f-${failure ? "bad" : "good"}.png`);
  await fs.writeFile(p, await canvas.encode("png"));
  return times.map((time) => ({ time, frame: Math.round(time * 30), frameTime: time, path: p }));
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "libi-frames-diag-"));
  __resetRenderDiagnosticsForTests();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const call = () =>
  renderFrames(new Request("http://x/api/render/frames", { method: "POST", body: JSON.stringify({ pieceId: "p1", atTimes: [1] }), headers: { "content-type": "application/json" } }));

describe("render frames reports a broken body", () => {
  it("returns the failure the pass filed, with the code file, and flags the empty frame blank; the fixed body then reads clean", async () => {
    frameCapture.run = (times) => fakeBackendPass(times, true, dir);
    const bad = await (await call()).json();
    expect(bad.renderDiagnostics).toEqual([
      expect.objectContaining({ overlayId: "heart", phase: "render", message: "heart is not defined", frame: 30, file: "/abs/heart/draw.jsx" }),
    ]);
    expect(bad.frames[0].blank).toBe(true);

    // The agent fixes the body (here: same body, but the pass now draws it and reports it clean).
    frameCapture.run = (times) => fakeBackendPass(times, false, dir);
    const good = await (await call()).json();
    expect(good.renderDiagnostics).toEqual([]);
    expect(good.frames[0].blank).toBeUndefined();
  });
});
