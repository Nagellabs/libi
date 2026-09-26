import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  __resetRenderDiagnosticsForTests,
  __storedPieceIdsForTests,
  getRenderDiagnostics,
  getUnattributedDiagnostics,
} from "@/lib/render/render-diagnostics-store";
import { MAX_DIAGNOSTICS_PER_PIECE } from "@/lib/render/render-diagnostics-types";
import { createRenderDiagnosticsStore } from "@/lib/preview/render-diagnostics";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";

const warn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({
  serverLogger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/composition/persistence", () => ({
  loadManifest: async () => ({
    width: 1920, height: 1080, fps: 30,
    overlays: [{ id: "a", kind: "code", drawFunction: "1;", startTime: 0, duration: 1, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 1, height: 1 } }],
  }),
}));
vi.mock("@/lib/overlays/code-files", () => ({
  overlayCodeFilePath: async (_pieceId: string, o: { id: string }) => `/abs/${o.id}/draw.jsx`,
}));

import { PUT, GET } from "@/app/api/pieces/[pieceId]/render-diagnostics/route";

const params = { params: Promise.resolve({ pieceId: "p1" }) };
const put = (body: unknown) => PUT(new Request("http://127.0.0.1/api/pieces/p1/render-diagnostics", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), params);
const get = () => GET(new Request("http://127.0.0.1/api/pieces/p1/render-diagnostics"), params);

beforeEach(() => {
  __resetRenderDiagnosticsForTests();
  seedPiece(createTestDb(), { id: "p1" });
  warn.mockClear();
});
afterEach(() => resetTestDb());

describe("PUT/GET /api/pieces/[pieceId]/render-diagnostics", () => {
  it("PUT replaces the piece's set and answers 204; GET returns it with the code file path", async () => {
    const res = await put({ diagnostics: [{ overlayId: "a", kind: "code", phase: "render", message: "x", line: 2, column: 3, at: 5 }] });
    expect(res.status).toBe(204);
    expect(getRenderDiagnostics("p1")).toHaveLength(1);
    const got = await get();
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({
      diagnostics: [{ overlayId: "a", kind: "code", phase: "render", message: "x", line: 2, column: 3, at: 5, file: "/abs/a/draw.jsx" }],
      unattributed: [],
    });
  });
  it("PUT rejects a malformed body with 400", async () => {
    expect((await put({ diagnostics: "nope" })).status).toBe(400);
    expect((await put({ diagnostics: [{ overlayId: "a" }] })).status).toBe(400);
    expect((await put({ diagnostics: [], unattributed: [{ line: 1 }] })).status).toBe(400);
  });
  it("GET omits `file` for an overlay no longer in the manifest", async () => {
    await put({ diagnostics: [{ overlayId: "gone", kind: "code", phase: "render", message: "x", at: 1 }] });
    const got = await get();
    expect((await got.json()).diagnostics[0].file).toBeUndefined();
  });
  it("PUT carries the piece-level unattributed list and replaces it; omitting it empties it", async () => {
    const at = Date.now();
    await put({ diagnostics: [], unattributed: [{ message: "Refused to connect", at }] });
    expect(await (await get()).json()).toEqual({ diagnostics: [], unattributed: [{ message: "Refused to connect", at }] });
    await put({ diagnostics: [] });
    expect(getUnattributedDiagnostics("p1")).toEqual([]);
  });
  it("an empty PUT clears the piece (the preview's first sync after a reload)", async () => {
    await put({ diagnostics: [{ overlayId: "a", kind: "code", phase: "render", message: "x", at: 1 }] });
    expect((await put({ diagnostics: [] })).status).toBe(204);
    expect(await (await get()).json()).toEqual({ diagnostics: [], unattributed: [] });
  });
  it("a rejected PUT is logged, not silent (Task 11 fix M4)", async () => {
    await put({ diagnostics: "nope" });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ tag: "overlay-sandbox", op: "diagnostics_put_rejected", pieceId: "p1" }), expect.any(String));
  });
  it("PUT for a piece that does not exist is 404 and stores nothing — a late flush after a delete cannot resurrect it (Task 11 fix M1)", async () => {
    const res = await PUT(
      new Request("http://127.0.0.1/api/pieces/gone/render-diagnostics", { method: "PUT", body: JSON.stringify({ diagnostics: [{ overlayId: "a", kind: "code", phase: "render", message: "x", at: 1 }] }) }),
      { params: Promise.resolve({ pieceId: "gone" }) },
    );
    expect(res.status).toBe(404);
    expect(getRenderDiagnostics("gone")).toEqual([]);
    expect(__storedPieceIdsForTests()).not.toContain("gone");
  });
  it("an empty PUT leaves no entry behind for the piece (Task 11 fix M1)", async () => {
    await put({ diagnostics: [{ overlayId: "a", kind: "code", phase: "render", message: "x", at: 1 }] });
    await put({ diagnostics: [] });
    expect(__storedPieceIdsForTests()).toEqual([]);
  });
  it("more failing overlays than the route's cap: the client's PUT still lands, and clears still work (Task 11 fix I2)", async () => {
    const statuses: number[] = [];
    const store = createRenderDiagnosticsStore({
      pieceId: "p1",
      debounceMs: 0,
      put: async (_pieceId, payload) => {
        statuses.push((await put(payload)).status);
      },
    });
    const n = MAX_DIAGNOSTICS_PER_PIECE + 5;
    for (let i = 0; i < n; i++) store.report({ overlayId: `o${i}`, kind: "code", phase: i === 0 ? "compile" : "render", message: `boom ${i}` });
    await store.flush();
    expect(statuses).toEqual([204]);
    expect(getRenderDiagnostics("p1")).toHaveLength(MAX_DIAGNOSTICS_PER_PIECE);
    expect(getRenderDiagnostics("p1").map((d) => d.overlayId)).toContain("o0"); // the compile error, oldest, kept
    // Fix every overlay but two: the server follows.
    for (let i = 2; i < n; i++) store.clear(`o${i}`);
    await store.flush();
    expect(statuses.every((s) => s === 204)).toBe(true);
    expect(getRenderDiagnostics("p1").map((d) => d.overlayId).sort()).toEqual(["o0", "o1"]);
    store.dispose();
  });
});
