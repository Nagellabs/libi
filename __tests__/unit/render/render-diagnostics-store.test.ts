import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetRenderDiagnosticsForTests,
  getRenderDiagnostics,
  getUnattributedDiagnostics,
  mergeRenderDiagnostics,
  mergeUnattributedDiagnostics,
  applyExportDiagnostics,
  parseExportDiagnosticsReport,
  parseRenderDiagnostics,
  setRenderDiagnostics,
  setUnattributedDiagnostics,
  MAX_UNATTRIBUTED_PER_PIECE,
  clearRenderDiagnostics,
  UNATTRIBUTED_TTL_MS,
  __storedPieceIdsForTests,
} from "@/lib/render/render-diagnostics-store";

const d = (overlayId: string, message = "boom", at = 1) => ({ overlayId, kind: "code" as const, phase: "render" as const, message, at });
const u = (message: string, at: number) => ({ message, at });

beforeEach(() => __resetRenderDiagnosticsForTests());

describe("render diagnostics store (server, in-memory, spec §4.7)", () => {
  it("set replaces, get returns, pieces are isolated", () => {
    setRenderDiagnostics("p1", [d("a"), d("b")]);
    setRenderDiagnostics("p1", [d("b", "later")]);
    expect(getRenderDiagnostics("p1").map((x) => x.overlayId)).toEqual(["b"]);
    expect(getRenderDiagnostics("p2")).toEqual([]);
  });
  it("merge upserts by overlayId, newest `at` wins", () => {
    setRenderDiagnostics("p1", [d("a", "old", 1)]);
    mergeRenderDiagnostics("p1", [d("a", "new", 2), d("c", "c", 2)]);
    expect(getRenderDiagnostics("p1").map((x) => [x.overlayId, x.message])).toEqual([["a", "new"], ["c", "c"]]);
    mergeRenderDiagnostics("p1", [d("a", "stale", 0)]);
    expect(getRenderDiagnostics("p1").find((x) => x.overlayId === "a")?.message).toBe("new");
  });
  it("parseRenderDiagnostics keeps well-formed entries and drops the rest", () => {
    expect(parseRenderDiagnostics([d("a"), { overlayId: "b" }, "x", { ...d("c"), line: 3, column: 4 }])).toEqual([d("a"), { ...d("c"), line: 3, column: 4 }]);
    expect(parseRenderDiagnostics(null)).toEqual([]);
  });
  it("clearRenderDiagnostics drops one piece's lists (piece delete) and leaves the others", () => {
    setRenderDiagnostics("p1", [d("a")]);
    setUnattributedDiagnostics("p1", [u("x", 1)]);
    setRenderDiagnostics("p2", [d("b")]);
    clearRenderDiagnostics("p1");
    expect(getRenderDiagnostics("p1")).toEqual([]);
    expect(getUnattributedDiagnostics("p1", 1)).toEqual([]);
    expect(getRenderDiagnostics("p2")).toHaveLength(1);
  });
  it("a piece whose lists are both empty holds no entry (every opened piece used to leave one — Task 11 fix M1)", () => {
    setRenderDiagnostics("p1", [d("a")]);
    setUnattributedDiagnostics("p1", [u("x", 1)]);
    setRenderDiagnostics("p1", []);
    expect(__storedPieceIdsForTests()).toEqual(["p1"]); // the unattributed list still holds one
    setUnattributedDiagnostics("p1", []);
    expect(__storedPieceIdsForTests()).toEqual([]);
    setRenderDiagnostics("p2", []);
    setUnattributedDiagnostics("p2", []);
    expect(__storedPieceIdsForTests()).toEqual([]);
  });
  it("parse keeps a render error's failing `time`", () => {
    expect(parseRenderDiagnostics([{ ...d("a"), time: 1.5 }])).toEqual([{ ...d("a"), time: 1.5 }]);
  });
  it("parse keeps a render error's absolute `frame` beside its `time` (Task 12b re-review 2, N1)", () => {
    expect(parseRenderDiagnostics([{ ...d("a"), time: 0.067, frame: 2 }])).toEqual([{ ...d("a"), time: 0.067, frame: 2 }]);
    const report = parseExportDiagnosticsReport({ fps: 30, diagnostics: [{ ...d("a"), time: 0.067, frame: 2, sourceHash: "ha" }], unattributed: [], clean: [] });
    expect(report?.diagnostics).toEqual([{ ...d("a"), time: 0.067, frame: 2, sourceHash: "ha" }]);
    // A fractional or negative frame is malformed: the entry drops, as any other.
    expect(parseRenderDiagnostics([{ ...d("a"), frame: 2.5 }, { ...d("b"), frame: -1 }])).toEqual([]);
  });
  it("caps a piece at 50 entries (a broken piece can't grow memory forever)", () => {
    setRenderDiagnostics("p1", Array.from({ length: 80 }, (_, i) => d(`o${i}`)));
    expect(getRenderDiagnostics("p1")).toHaveLength(50);
  });
});

describe("unattributed diagnostics (no overlay to blame — piece-level list)", () => {
  it("set replaces per piece; reset clears them with the rest", () => {
    setUnattributedDiagnostics("p1", [u("a", 100), u("b", 100)]);
    setUnattributedDiagnostics("p1", [u("c", 100)]);
    expect(getUnattributedDiagnostics("p1", 100).map((x) => x.message)).toEqual(["c"]);
    expect(getUnattributedDiagnostics("p2", 100)).toEqual([]);
    __resetRenderDiagnosticsForTests();
    expect(getUnattributedDiagnostics("p1", 100)).toEqual([]);
  });
  it("keeps the newest entries up to the cap", () => {
    setUnattributedDiagnostics("p1", Array.from({ length: 25 }, (_, i) => u(`m${i}`, i)));
    const kept = getUnattributedDiagnostics("p1", 25);
    expect(kept).toHaveLength(MAX_UNATTRIBUTED_PER_PIECE);
    expect(kept[kept.length - 1]!.message).toBe("m24");
  });
  it("drops entries older than the TTL — nothing else can clear them", () => {
    setUnattributedDiagnostics("p1", [u("old", 0), u("fresh", UNATTRIBUTED_TTL_MS)]);
    expect(getUnattributedDiagnostics("p1", UNATTRIBUTED_TTL_MS + 1).map((x) => x.message)).toEqual(["fresh"]);
  });
});

describe("two writers: the preview's PUT and an export's merge (Task 10)", () => {
  const hashes = (m: Record<string, string>) => (id: string) => m[id];
  const report = (over: Partial<Parameters<typeof applyExportDiagnostics>[1]> = {}) => ({ fps: 30, diagnostics: [], unattributed: [], clean: [], ...over });

  it("a preview PUT replaces only the preview's list — it cannot wipe what an export found", () => {
    mergeRenderDiagnostics("p1", [{ ...d("a", "export found", 5), sourceHash: "ha", time: 2 }]);
    setRenderDiagnostics("p1", [d("b", "preview sees", 6)]);
    setRenderDiagnostics("p1", []); // a stale paused preview with nothing on screen
    expect(getRenderDiagnostics("p1", hashes({ a: "ha" })).map((x) => [x.overlayId, x.message])).toEqual([["a", "export found"]]);
  });
  it("per overlay the newer entry wins, whichever writer it came from; sourceHash never leaves the store", () => {
    setRenderDiagnostics("p1", [d("a", "preview", 10)]);
    mergeRenderDiagnostics("p1", [{ ...d("a", "export", 5), sourceHash: "ha" }]);
    expect(getRenderDiagnostics("p1", hashes({ a: "ha" }))[0].message).toBe("preview");
    mergeRenderDiagnostics("p1", [{ ...d("a", "export later", 20), sourceHash: "ha" }]);
    const [got] = getRenderDiagnostics("p1", hashes({ a: "ha" }));
    expect(got.message).toBe("export later");
    expect(got).not.toHaveProperty("sourceHash");
  });
  it("an export entry is dropped once its body is no longer the overlay's draft body (the fix landed, or the overlay is gone)", () => {
    mergeRenderDiagnostics("p1", [{ ...d("a"), sourceHash: "old" }, { ...d("gone"), sourceHash: "hg" }]);
    expect(getRenderDiagnostics("p1", hashes({ a: "new" }))).toEqual([]);
    // Dropped for good, not merely hidden.
    expect(getRenderDiagnostics("p1")).toEqual([]);
  });
  it("applyExportDiagnostics merges only failures of the CURRENT body (a snapshot render files nothing against the draft)", () => {
    applyExportDiagnostics(
      "p1",
      report({ diagnostics: [{ ...d("a", "current"), sourceHash: "ha", time: 1 }, { ...d("b", "snapshot body"), sourceHash: "old" }] }),
      hashes({ a: "ha", b: "new" }),
    );
    expect(getRenderDiagnostics("p1", hashes({ a: "ha", b: "new" })).map((x) => x.message)).toEqual(["current"]);
  });
  it("a clean frame of the current body retires a render entry at that time — in either list — and nothing at another time", () => {
    setRenderDiagnostics("p1", [{ ...d("a", "preview at 1s"), time: 1 }]);
    mergeRenderDiagnostics("p1", [{ ...d("b", "export at 2s"), time: 2, sourceHash: "hb" }, { ...d("c", "export at 5s"), time: 5, sourceHash: "hc" }]);
    applyExportDiagnostics(
      "p1",
      report({
        clean: [
          { overlayId: "a", sourceHash: "ha", frames: [[0, 45]] },
          { overlayId: "b", sourceHash: "hb", frames: [[60, 61]] },
          { overlayId: "c", sourceHash: "hc", frames: [[0, 149]] }, // 5 s = frame 150: not drawn clean
        ],
      }),
      hashes({ a: "ha", b: "hb", c: "hc" }),
    );
    expect(getRenderDiagnostics("p1", hashes({ a: "ha", b: "hb", c: "hc" })).map((x) => x.overlayId)).toEqual(["c"]);
  });
  it("a clean frame proves nothing about a DIFFERENT source, and nothing about a render entry with no time", () => {
    mergeRenderDiagnostics("p1", [{ ...d("a"), time: 1, sourceHash: "ha" }, { ...d("b", "async escape"), sourceHash: "hb" }]);
    applyExportDiagnostics(
      "p1",
      report({ clean: [{ overlayId: "a", sourceHash: "snapshot", frames: [[0, 100]] }, { overlayId: "b", sourceHash: "hb", frames: [[0, 100]] }] }),
      hashes({ a: "ha", b: "hb" }),
    );
    expect(getRenderDiagnostics("p1", hashes({ a: "ha", b: "hb" })).map((x) => x.overlayId)).toEqual(["a", "b"]);
  });
  it("any clean frame of the current body retires its compile/build entry (it just compiled and built)", () => {
    setRenderDiagnostics("p1", [{ ...d("a"), phase: "build" as const }]);
    applyExportDiagnostics("p1", report({ clean: [{ overlayId: "a", sourceHash: "ha", frames: [[10, 11]] }] }), hashes({ a: "ha" }));
    expect(getRenderDiagnostics("p1", hashes({ a: "ha" }))).toEqual([]);
  });
  it("unattributed: the export merges into its own list; a preview PUT replaces only the preview's; reads get both", () => {
    mergeUnattributedDiagnostics("p1", [u("from export", 100)]);
    setUnattributedDiagnostics("p1", [u("from preview", 200)]);
    setUnattributedDiagnostics("p1", []);
    expect(getUnattributedDiagnostics("p1", 300).map((x) => x.message)).toEqual(["from export"]);
    applyExportDiagnostics("p1", report({ unattributed: [u("from export", 400)] }), hashes({}));
    expect(getUnattributedDiagnostics("p1", 400)).toEqual([u("from export", 400)]);
  });
  it("clearRenderDiagnostics (piece delete) drops the export lists too", () => {
    mergeRenderDiagnostics("p1", [{ ...d("a"), sourceHash: "h" }]);
    mergeUnattributedDiagnostics("p1", [u("x", 1)]);
    expect(__storedPieceIdsForTests()).toEqual(["p1"]);
    clearRenderDiagnostics("p1");
    expect(__storedPieceIdsForTests()).toEqual([]);
  });
  it("parseExportDiagnosticsReport drops a malformed entry, not the report; a wrong envelope is null", () => {
    const parsed = parseExportDiagnosticsReport({
      fps: 30,
      diagnostics: [{ ...d("a"), sourceHash: "h", time: 1 }, { overlayId: "bad" }],
      unattributed: [u("m", 1), { at: 1 }],
      clean: [{ overlayId: "a", sourceHash: "h", frames: [[0, 3]] }, { overlayId: "a", frames: "all" }],
    });
    expect(parsed).toEqual({
      fps: 30,
      diagnostics: [{ ...d("a"), sourceHash: "h", time: 1 }],
      unattributed: [u("m", 1)],
      clean: [{ overlayId: "a", sourceHash: "h", frames: [[0, 3]] }],
    });
    expect(parseExportDiagnosticsReport({ fps: 0, diagnostics: [], unattributed: [], clean: [] })).toBeNull();
    expect(parseExportDiagnosticsReport([])).toBeNull();
  });
});
