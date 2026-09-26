/**
 * Text plates (and the blurred-shadow colour fill) are drawn on an RGBA layer
 * and composited with `overlay`, never with `drawbox` straight onto the YUV
 * frame.
 *
 * `drawbox` on a YUV frame converts its colour with a hard-coded BT.601
 * limited-range formula, whatever the frame declares — so on a BT.709 base
 * (a tagged one, or an untagged HD one lib/export/untagged-color.ts declares)
 * a pure green plate played back as 0,215,0. On an RGBA frame drawbox writes
 * the colour as-is, and `overlay` converts the layer into the frame with the
 * frame's own matrix (ffmpeg ≥ 7.1; older builds convert with 601 — today's
 * colour, and the same graph still runs).
 */
import { describe, it, expect } from "vitest";
import {
  plateSpecFor,
  plateLayerSegments,
  shadowLayerSegments,
} from "@/lib/export/overlay-filter";
import { buildFilterChain } from "@/lib/export/backends/ffmpeg-overlay";
import type { Overlay } from "@/lib/engine/types";
import type { ExportTextLayout } from "@/lib/export/text-export-layout";

const layout = (plate: { x: number; y: number; width: number; height: number; color: string }) =>
  ({ lines: ["x"], plate } as unknown as ExportTextLayout);
const text = (startTime: number, duration: number) =>
  ({ id: "t", kind: "text", startTime, duration, opacity: 1 } as never);

describe("plateSpecFor with a layer origin", () => {
  it("is unchanged without an origin (today's string)", () => {
    expect(plateSpecFor(text(1, 2), layout({ x: 101, y: 51, width: 64, height: 30, color: "#00ff00" }), 0, 1)).toBe(
      "drawbox=x=101:y=51:w=64:h=30:color=#00ff00:t=fill:enable='gte(t,1)*lt(t,3)'",
    );
  });

  it("translates by the origin and REPLACES (the layer is transparent; the colour's alpha is kept for overlay)", () => {
    expect(
      plateSpecFor(text(1, 2), layout({ x: 101, y: 51, width: 64, height: 30, color: "#00ff0080" }), 0, 1, { x: 100, y: 50 }),
    ).toBe("drawbox=x=1:y=1:w=64:h=30:color=#00ff0080:t=fill:replace=1:enable='gte(t,1)*lt(t,3)'");
  });
});

describe("plateLayerSegments", () => {
  const plates = [
    { x: 101, y: 51, w: 64, h: 30, spec: "" },
    { x: 301, y: 401, w: 20, h: 21, spec: "" },
  ];

  it("crops an even-aligned bounding box of the plates, clears it to transparent RGBA, draws, overlays it back", () => {
    const segs = plateLayerSegments(
      [
        { rect: plates[0], drawbox: (o) => `P0@${o.x},${o.y}` },
        { rect: plates[1], drawbox: (o) => `P1@${o.x},${o.y}` },
      ],
      { width: 1920, height: 1080 },
      "gte(t,0)*lt(t,5)",
      "cur",
      "out",
      "7",
    );
    // bbox x 101..321 → 100..322, y 51..422 → 50..422
    expect(segs).toEqual([
      "[cur]format=yuv420p,split[tpm7][tps7]",
      "[tps7]crop=222:372:100:50,format=rgba,drawbox=x=0:y=0:w=222:h=372:color=black@0:t=fill:replace=1:enable='gte(t,0)*lt(t,5)',P0@100,50,P1@100,50[tpl7]",
      "[tpm7][tpl7]overlay=100:50:enable='gte(t,0)*lt(t,5)'[out]",
    ]);
  });

  it("clears the layer to the first plate's colour at alpha 0 (no dark fringe from 4:2:0 averaging)", () => {
    const segs = plateLayerSegments(
      [{ rect: { x: 0, y: 0, w: 10, h: 10 }, drawbox: () => "P", color: "#00ff00" }],
      { width: 100, height: 100 }, "1", "a", "b", "k",
    );
    expect(segs[1]).toContain("drawbox=x=0:y=0:w=10:h=10:color=#00ff0000:t=fill:replace=1:enable='1',P[");
  });

  it("clamps the box to the frame; a box fully off-frame passes the frame through", () => {
    const segs = plateLayerSegments(
      [{ rect: { x: -10, y: 1070, w: 40, h: 40 }, drawbox: (o) => `P@${o.x},${o.y}` }],
      { width: 1920, height: 1080 },
      "1",
      "a",
      "b",
      "k",
    );
    expect(segs[1]).toContain("crop=30:10:0:1070,");
    expect(segs[1]).toContain("P@0,1070");
    expect(
      plateLayerSegments([{ rect: { x: 2000, y: 0, w: 10, h: 10 }, drawbox: () => "P" }], { width: 1920, height: 1080 }, "1", "a", "b", "k"),
    ).toEqual(["[a]null[b]"]);
  });
});

describe("shadowLayerSegments", () => {
  it("fills the shadow colour on RGBA, not on yuva420p", () => {
    const segs = shadowLayerSegments(["S"], { sigma: 4, color: "#00ff00", alpha: 0.5 }, { top: 10, height: 40 }, "1", "a", "b", "0");
    const fill = segs.find((s) => s.includes("drawbox"))!;
    expect(fill).toContain("format=rgba,drawbox=c=#00ff00:t=fill:replace=1");
    expect(segs.join(";")).not.toContain("yuva420p");
  });
});

describe("buildFilterChain — plates through the RGBA layer", () => {
  const cue = (id: string, startTime: number, extra: Record<string, unknown> = {}) =>
    ({
      id, kind: "text", content: "Hi", font: "48px Inter", fontSize: 48, color: "#ffffff", align: "center",
      anchor: "mid-center", opacity: 1, startTime, duration: 1, z: 1,
      rect: { x: 100, y: 800, width: 880, height: 120 },
      background: { color: "#00ff00", padding: 12, radius: 8 },
      ...extra,
    } as unknown as Overlay);

  it("never drawboxes a plate onto the YUV frame (no-shadow run)", () => {
    const graph = buildFilterChain([cue("a", 0), cue("b", 1)], new Map(), { width: 1080, height: 1920 });
    const segs = graph.split(";");
    // one plate layer for the whole run, composited with the run's union window
    expect(segs.filter((s) => s.includes("split[tpm"))).toHaveLength(1);
    const layer = segs.find((s) => s.startsWith("[tps"))!;
    expect(layer.match(/color=#00ff00:t=fill:replace=1/g)).toHaveLength(2);
    expect(segs.find((s) => s.includes("overlay="))).toContain("enable='gte(t,0)*lt(t,2)'");
    // every drawbox lives in the layer (after format=rgba)
    for (const s of segs) if (s.includes("drawbox")) expect(s).toContain("format=rgba");
    // plates are composited before either cue's text
    expect(graph.indexOf("overlay=")).toBeLessThan(graph.indexOf("drawtext="));
  });

  it("the shadow path uses the same layer", () => {
    const graph = buildFilterChain(
      [cue("a", 0, { shadow: { color: "#000000", blur: 8, dx: 0, dy: 2 } })],
      new Map(),
      { width: 1080, height: 1920 },
    );
    for (const s of graph.split(";")) if (s.includes("drawbox")) expect(s).toContain("format=rgba");
    expect(graph).toContain("split[tpm");
  });

  it("a run without plates is unchanged (no layer)", () => {
    const graph = buildFilterChain([cue("a", 0, { background: undefined })], new Map(), { width: 1080, height: 1920 });
    expect(graph).not.toContain("drawbox");
    expect(graph).not.toContain("split");
  });
});
