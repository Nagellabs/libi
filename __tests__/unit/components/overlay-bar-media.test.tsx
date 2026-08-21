// @vitest-environment jsdom
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { Composition } from "@/lib/engine/types";
import {
  buildMediaById,
  distinctVideoFileIds,
  resolveMediaPaint,
} from "@/lib/preview/timeline-media";
import { OverlayBar, type OverlayBarModel } from "@/components/preview/overlay-bar";
import type { LaneView } from "@/lib/preview/lane-bar-geometry";

function comp(): Composition {
  return {
    width: 1920,
    height: 1080,
    fps: 30,
    scenes: [
    ],
    overlays: [
      { id: "oi", kind: "image", fileId: "img-1", startTime: 0, duration: 2, z: 1, rect: { x: 0, y: 0, w: 1, h: 1 } },
      { id: "ov", kind: "video", fileId: "vid-2", startTime: 0, duration: 3, z: 2, rect: { x: 0, y: 0, w: 1, h: 1 } },
      { id: "ot", kind: "text", content: "hi", startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, font: "24px Inter", color: "#fff", align: "left" },
    ],
  } as unknown as Composition;
}

describe("buildMediaById / distinctVideoFileIds", () => {
  it("collects image+video overlays (skips text overlays)", () => {
    const m = buildMediaById(comp());
    expect(m.get("oi")).toEqual({ kind: "image", fileId: "img-1" });
    expect(m.get("ov")).toEqual({ kind: "video", fileId: "vid-2" });
    expect(m.has("ot")).toBe(false); // text overlay
  });

  it("distinctVideoFileIds returns only the video fileIds", () => {
    const ids = distinctVideoFileIds(buildMediaById(comp())).sort();
    expect(ids).toEqual(["vid-2"]);
  });

  it("null composition → empty map", () => {
    expect(buildMediaById(null).size).toBe(0);
  });
});

describe("resolveMediaPaint", () => {
  it("image → content url, cover", () => {
    const paint = resolveMediaPaint({
      ref: { kind: "image", fileId: "img-1" },
      barWidthPx: 200,
    });
    expect(paint?.backgroundImage).toBe("url(/api/files/by-id/img-1/content)");
    expect(paint?.backgroundSize).toBe("cover");
  });

  it("video + ready filmstrip → sprite url + tile geometry", () => {
    const paint = resolveMediaPaint({
      ref: { kind: "video", fileId: "vid-2" },
      status: { status: "ready", filename: "f.jpg", frames: 20, height: 48, generatedAt: null },
      barWidthPx: 400,
    });
    expect(paint?.backgroundImage).toBe("url(/api/files/by-id/vid-2/filmstrip)");
    expect(paint?.backgroundSize).toBe("100% 100%");
  });

  it("video + not-ready filmstrip → null (solid fallback)", () => {
    const paint = resolveMediaPaint({
      ref: { kind: "video", fileId: "vid-2" },
      status: { status: "generating", filename: null, frames: null, height: null, generatedAt: null },
      barWidthPx: 400,
    });
    expect(paint).toBeNull();
  });

  it("undefined ref → null", () => {
    expect(resolveMediaPaint({ ref: undefined, barWidthPx: 1 })).toBeNull();
  });
});

const view: LaneView = { trackWidth: 600, totalFrames: 120, fps: 30 };

function bar(): OverlayBarModel {
  return {
    id: "ov",
    kind: "video",
    startTime: 0,
    duration: 3,
    subLane: 0,
    selected: false,
    hidden: false,
    locked: true, // locked → no trim handles, simpler DOM
  };
}

describe("OverlayBar media painting", () => {
  it("paints the background image + flags data-media when paint is provided", () => {
    const { getByTestId } = render(
      <OverlayBar
        bar={bar()}
        view={view}
        subLaneHeight={28}
        onSelect={() => {}}
        onCommitTiming={() => {}}
        onCrossRow={() => {}}
        mediaPaint={{
          backgroundImage: "url(/api/files/by-id/vid-2/filmstrip)",
          backgroundSize: "100% 100%",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "left center",
        }}
      />,
    );
    const el = getByTestId("overlay-bar-ov");
    expect(el.getAttribute("data-media")).toBe("painted");
    expect(el.style.backgroundImage).toContain("vid-2/filmstrip");
  });

  it("no data-media + no backgroundImage when paint is null (fallback)", () => {
    const { getByTestId } = render(
      <OverlayBar
        bar={bar()}
        view={view}
        subLaneHeight={28}
        onSelect={() => {}}
        onCommitTiming={() => {}}
        onCrossRow={() => {}}
        mediaPaint={null}
      />,
    );
    const el = getByTestId("overlay-bar-ov");
    expect(el.getAttribute("data-media")).toBeNull();
    expect(el.style.backgroundImage).toBe("");
  });
});

