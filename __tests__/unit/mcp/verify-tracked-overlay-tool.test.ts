import { describe, it, expect, afterEach, vi } from "vitest";
import { verifyTrackedOverlay } from "@/mcp/tools/tracking-tools";

afterEach(() => vi.restoreAllMocks());

describe("verifyTrackedOverlay", () => {
  it("returns the route payload as a successful ToolResult", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ success: true, frames: [{ time: 0, pngBase64: "AAAA" }], summary: {}, segments: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ) as Response,
    );
    const r = await verifyTrackedOverlay({
      fileId: "f1", trackId: "t1", content: { kind: "emoji", char: "x" }, fit: "tight",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data!.frames).toHaveLength(1);
  });

  it("maps a fetch failure to libi_server_unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await verifyTrackedOverlay({ pieceId: "p1", overlayId: "o1" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBe("libi_server_unavailable");
  });

  it("surfaces a non-200 route error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: "track not found: t1" }), { status: 404 }) as Response,
    );
    const r = await verifyTrackedOverlay({ fileId: "f1", trackId: "t1", content: { kind: "emoji", char: "x" }, fit: "tight" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/track not found/);
  });
});
