import { describe, it, expect, beforeEach, vi } from "vitest";
import { sha256Hex } from "@/lib/sandbox/hash";

/** The piece's current draft: one fixed code overlay and one broken one. */
const FIXED = "context.ctx.fillRect(0, 0, context.width, context.height);";
const BROKEN = "nope();";
const persistence = vi.hoisted(() => ({ hasManifest: true, loadManifestCalls: 0, brokenBody: "nope();" }));
vi.mock("@/lib/composition/persistence", () => ({
  hasManifest: async () => persistence.hasManifest,
  loadManifest: async () => (persistence.loadManifestCalls++, {
    width: 1920, height: 1080, fps: 30,
    overlays: [
      { id: "fixed", kind: "code", drawFunction: FIXED, startTime: 0, duration: 2, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 10, height: 10 } },
      { id: "broken", kind: "code", drawFunction: persistence.brokenBody, startTime: 0, duration: 2, z: 1, opacity: 1, rect: { x: 0, y: 0, width: 10, height: 10 } },
    ],
  }),
}));

import { createRenderJob } from "@/lib/export/render-jobs";
import { loadManifest } from "@/lib/composition/persistence";
import { bodyHashesOf } from "@/lib/render/body-hashes";
import {
  __resetRenderDiagnosticsForTests,
  __storedPieceIdsForTests,
  getRenderDiagnostics,
  setRenderDiagnostics,
} from "@/lib/render/render-diagnostics-store";
import { POST } from "@/app/api/export/render-result/route";

function job() {
  return createRenderJob({
    pieceId: "p1",
    payload: { overlays: [], audioClips: [], width: 1920, height: 1080, fps: 30, files: [] },
    settings: { format: "mp4", codec: "avc", bitrate: 1, width: 1920, height: 1080, fps: 30 },
  });
}

/** Exactly what the real render page's postback carries: `render-entry.ts`
 *  `fetch("/api/export/render-result")` from a page both export drivers load at
 *  `http://127.0.0.1:<port>/render` — a same-origin CORS-mode POST. Measured on
 *  the live dev server (Chromium): Host 127.0.0.1:3461, Origin
 *  http://127.0.0.1:3461, Sec-Fetch-Site same-origin. The route re-runs the
 *  origin guard itself (it sits outside proxy.ts), so a header-less `Request`
 *  is refused 403 before it is ever parsed. */
const RENDER_PAGE_HEADERS = {
  host: "127.0.0.1:3461",
  origin: "http://127.0.0.1:3461",
  "sec-fetch-site": "same-origin",
};

function postback(jobId: string, token: string, extra: Record<string, string>) {
  const fd = new FormData();
  fd.append("jobId", jobId);
  fd.append("token", token);
  fd.append("durationSeconds", "2");
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  fd.append("file", new Blob([new Uint8Array([0])]), "out.mp4");
  return POST(new Request("http://127.0.0.1:3461/api/export/render-result", { method: "POST", body: fd, headers: RENDER_PAGE_HEADERS }));
}

beforeEach(() => {
  __resetRenderDiagnosticsForTests();
  persistence.hasManifest = true;
  persistence.loadManifestCalls = 0;
  persistence.brokenBody = BROKEN;
});

/** What `GET /api/pieces/[id]/render-diagnostics` (libi.get_piece_state) returns:
 *  judged against the manifest's CURRENT bodies. */
async function readAsAgent() {
  const hashes = await bodyHashesOf((await loadManifest("p1")).overlays ?? []);
  return getRenderDiagnostics("p1", (id) => hashes.get(id));
}

/** A render_overlay_frames pass over the current body that fails at frame 2. */
async function renderFailing(message: string, at: number) {
  const handle = job();
  const seenAtResolve = handle.done.then(readAsAgent);
  const res = await postback(handle.jobId, handle.token, {
    renderDiagnostics: JSON.stringify({
      fps: 30,
      diagnostics: [
        { overlayId: "broken", kind: "code", phase: "render", message, line: 1, column: 1, time: 0.067, frame: 2, sourceHash: await sha256Hex(persistence.brokenBody), at },
      ],
      unattributed: [],
      clean: [],
    }),
  });
  expect(res.status).toBe(200);
  return seenAtResolve;
}

describe("POST /api/export/render-result — renderDiagnostics (spec §4.7, Task 10)", () => {
  it("merges a broken body's failure with its `time` BEFORE the job resolves, and retires what a clean frame of the fixed body disproves", async () => {
    const [hFixed, hBroken] = await Promise.all([sha256Hex(FIXED), sha256Hex(BROKEN)]);
    // An old preview report: the fixed overlay failed at 1 s before its fix.
    setRenderDiagnostics("p1", [{ overlayId: "fixed", kind: "code", phase: "render", message: "old failure", time: 1, at: 1 }]);
    const handle = job();
    const seenAtResolve = handle.done.then(() => getRenderDiagnostics("p1"));
    const res = await postback(handle.jobId, handle.token, {
      renderDiagnostics: JSON.stringify({
        fps: 30,
        diagnostics: [
          { overlayId: "broken", kind: "code", phase: "render", message: "nope is not defined", line: 1, column: 1, time: 0.1, sourceHash: hBroken, at: 5 },
        ],
        unattributed: [],
        clean: [{ overlayId: "fixed", sourceHash: hFixed, frames: [[0, 60]] }],
      }),
    });
    expect(res.status).toBe(200);
    const atResolve = await seenAtResolve;
    expect(atResolve).toEqual([
      { overlayId: "broken", kind: "code", phase: "render", message: "nope is not defined", line: 1, column: 1, time: 0.1, at: 5 },
    ]);
  });

  it("a malformed renderDiagnostics field never fails the postback", async () => {
    const handle = job();
    const res = await postback(handle.jobId, handle.token, { renderDiagnostics: "{not json" });
    expect(res.status).toBe(200);
    await expect(handle.done).resolves.toMatchObject({ durationSeconds: 2 });
    expect(getRenderDiagnostics("p1")).toEqual([]);
  });

  it("a postback for a piece deleted mid-render files nothing: no manifest is (re)created and no store key comes back (Task 10 review, minor 2)", async () => {
    persistence.hasManifest = false; // deletePieceCompletely removed the piece dir
    const handle = job();
    const res = await postback(handle.jobId, handle.token, {
      renderDiagnostics: JSON.stringify({
        fps: 30,
        diagnostics: [],
        unattributed: [{ message: "late runtime error", at: 5 }],
        clean: [],
      }),
    });
    expect(res.status).toBe(200);
    await expect(handle.done).resolves.toMatchObject({ durationSeconds: 2 });
    // loadManifest WRITES an empty snapshot for a missing manifest.
    expect(persistence.loadManifestCalls).toBe(0);
    expect(__storedPieceIdsForTests()).not.toContain("p1");
  });

  // skill-eval code-overlays 01 #7 / 02 #3 lean on this: an agent's "clean" read after its last
  // edit counts only if a render of the NEW body would have re-recorded a failure there.
  it("a saved fix that STILL throws: its entry leaves with the old body, and the next render re-records one for the new body before it resolves", async () => {
    const first = await renderFailing("nope is not defined", 5);
    expect(first).toEqual([expect.objectContaining({ overlayId: "broken", message: "nope is not defined", frame: 2 })]);

    persistence.brokenBody = "stillNope();"; // the agent's edit — still broken
    expect(await readAsAgent()).toEqual([]); // the save alone clears it: an empty read here proves nothing

    const second = await renderFailing("stillNope is not defined", 9);
    expect(second).toEqual([expect.objectContaining({ overlayId: "broken", message: "stillNope is not defined", time: 0.067, frame: 2 })]);
  });
});
