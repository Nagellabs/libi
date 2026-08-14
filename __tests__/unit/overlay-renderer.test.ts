// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { drawOverlay } from "@/lib/engine/overlay-renderer";
import type { TextOverlay } from "@/lib/engine/types";

/**
 * Minimal CanvasRenderingContext2D mock. We only care about recording the
 * state-affecting calls the overlay renderer actually makes. Property
 * assignments (font, fillStyle, textAlign, etc.) are plain fields. Methods
 * are jest-style stubs that record their args.
 */
function mkMockCtx() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const record = (name: string) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
    };
  const ctx = {
    save: record("save"),
    restore: record("restore"),
    fillText: record("fillText"),
    drawImage: record("drawImage"),
    beginPath: record("beginPath"),
    rect: record("rect"),
    clip: record("clip"),
    translate: record("translate"),
    fillRect: record("fillRect"),
    globalAlpha: 1,
    font: "",
    fillStyle: "",
    textAlign: "start",
    textBaseline: "alphabetic",
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe("drawOverlay", () => {
  it("text overlay: fillText is called at the expected position (left align)", () => {
    const { ctx, calls } = mkMockCtx();
    const overlay: TextOverlay = {
      id: "t",
      kind: "text",
      content: "hi",
      font: "16px Inter",
      color: "#fff",
      align: "left",
      opacity: 1,
      rect: { x: 10, y: 20, width: 100, height: 30 },
      startTime: 0,
      duration: 1,
      z: 0,
    };

    drawOverlay(overlay, {
      ctx,
      width: 200,
      height: 200,
      fps: 30,
      totalFrames: 1,
      frame: 0,
      time: 0.5,
      assets: {},
    });

    const fillTextCalls = calls.filter((c) => c.name === "fillText");
    expect(fillTextCalls).toHaveLength(1);
    // y is vertically centered within rect.height: rect.y + (30 - 16*1.2)/2 = 20 + 5.4.
    expect(fillTextCalls[0].args).toEqual(["hi", 10, 25.4]);
  });

  it("text overlay with center align draws at rect.x + width/2", () => {
    const { ctx, calls } = mkMockCtx();
    const overlay: TextOverlay = {
      id: "t",
      kind: "text",
      content: "centered",
      font: "16px Inter",
      color: "#fff",
      align: "center",
      opacity: 0.5,
      rect: { x: 10, y: 20, width: 100, height: 30 },
      startTime: 0,
      duration: 1,
      z: 0,
    };

    drawOverlay(overlay, {
      ctx,
      width: 200,
      height: 200,
      fps: 30,
      totalFrames: 1,
      frame: 0,
      time: 0.5,
      assets: {},
    });

    const fillTextCalls = calls.filter((c) => c.name === "fillText");
    // x = rect.x + width/2 (center align); y vertically centered (see above): 25.4.
    expect(fillTextCalls[0].args).toEqual(["centered", 60, 25.4]);
  });

  it("always wraps the draw in save/restore", () => {
    const { ctx, calls } = mkMockCtx();
    const overlay: TextOverlay = {
      id: "t",
      kind: "text",
      content: "x",
      font: "16px Inter",
      color: "#fff",
      align: "left",
      opacity: 1,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      startTime: 0,
      duration: 1,
      z: 0,
    };

    drawOverlay(overlay, {
      ctx,
      width: 100,
      height: 100,
      fps: 30,
      totalFrames: 1,
      frame: 0,
      time: 0,
      assets: {},
    });

    expect(calls[0].name).toBe("save");
    expect(calls[calls.length - 1].name).toBe("restore");
  });
});
