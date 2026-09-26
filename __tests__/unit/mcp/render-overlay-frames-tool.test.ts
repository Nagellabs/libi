import { describe, it, expect, vi, afterEach } from "vitest";

// libi.render_overlay_frames (Task 12b re-review 2): each frame names the frame
// it drew, and a time past the end of the piece reaches the agent as the
// route's whole per-time refusal — not a 300-char cut of raw JSON.

vi.mock("@/lib/libi-home", async (orig) => ({
  ...(await orig<typeof import("@/lib/libi-home")>()),
  getCurrentPort: () => 3999,
}));

import { renderOverlayFrames } from "@/mcp/tools/render-tools";

describe("libi.render_overlay_frames", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("N1: passes each frame's `frame` through", async () => {
    const frames = [{ time: 0.067, frame: 2, path: "/abs/frame-67ms.png", overflow: { touchesEdge: false, edges: [] } }];
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ frames, unresolvedFonts: [] }), { status: 200 })) as never;
    const result = await renderOverlayFrames({ pieceId: "p1", atTimes: [0.067] });
    expect(result).toEqual({ success: true, data: { frames, unresolvedFonts: [] } });
  });

  it("N2: a time past the end is refused with the route's per-time errors, duration and last valid time", async () => {
    const error =
      "atTimes 5, 60 are at or past the end of the piece: the piece is 5 s long (150 frames at 30 fps), so the last valid time is 4.967 (frame 149).";
    const errors = [
      { time: 5, error: "5 is at or past the end of the piece: …" },
      { time: 60, error: "60 is at or past the end of the piece: …" },
    ];
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: error + " ".repeat(400), errors, duration: 5, lastValidTime: 4.967 }), { status: 400 }),
    ) as never;
    const result = await renderOverlayFrames({ pieceId: "p1", atTimes: [1, 5, 60] });
    expect(result.success).toBe(false);
    expect(result.error).toBe(`render_overlay_frames refused: ${error}${" ".repeat(400)}`);
    expect(result.data).toEqual({ errors, duration: 5, lastValidTime: 4.967 });
  });
});
