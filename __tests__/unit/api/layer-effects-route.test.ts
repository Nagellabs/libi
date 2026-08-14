import { describe, it, expect, vi, beforeEach } from "vitest";

const { applyLayerEffect, clearLayerEffect } = vi.hoisted(() => ({
  applyLayerEffect: vi.fn(),
  clearLayerEffect: vi.fn(),
}));
vi.mock("@/mcp/tools/effect-tools", () => ({ applyLayerEffect, clearLayerEffect }));

import { POST, DELETE } from "@/app/api/pieces/[pieceId]/layers/[layerId]/effects/route";

function ctx(pieceId: string, layerId: string) {
  return { params: Promise.resolve({ pieceId, layerId }) };
}

describe("POST/DELETE /api/pieces/[pieceId]/layers/[layerId]/effects", () => {
  beforeEach(() => {
    applyLayerEffect.mockReset();
    clearLayerEffect.mockReset();
  });

  it("POST applies an effect and returns layerKind", async () => {
    applyLayerEffect.mockResolvedValue({ success: true, data: { layerKind: "overlay-text" } });
    const req = new Request("http://x", {
      method: "POST",
      body: JSON.stringify({ phase: "in", effectId: "fade", durationMs: 500 }),
    });
    const res = await POST(req, ctx("p1", "ov1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, layerKind: "overlay-text" });
    expect(applyLayerEffect).toHaveBeenCalledWith({
      pieceId: "p1", layerId: "ov1", phase: "in", effectId: "fade", durationMs: 500, params: undefined,
    });
  });

  it("POST returns 400 with the structured error on unknown effect", async () => {
    applyLayerEffect.mockResolvedValue({ success: false, error: "unknown_effect", data: { hint: "x" } });
    const req = new Request("http://x", { method: "POST", body: JSON.stringify({ phase: "in", effectId: "nope" }) });
    const res = await POST(req, ctx("p1", "ov1"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unknown_effect");
  });

  it("POST returns 400 on a malformed body", async () => {
    const req = new Request("http://x", { method: "POST", body: JSON.stringify({ phase: "sideways" }) });
    const res = await POST(req, ctx("p1", "ov1"));
    expect(res.status).toBe(400);
  });

  it("DELETE clears the phase", async () => {
    clearLayerEffect.mockResolvedValue({ success: true, data: { layerKind: "scene" } });
    const req = new Request("http://x?phase=out", { method: "DELETE" });
    const res = await DELETE(req, ctx("p1", "sc1"));
    expect(res.status).toBe(200);
    expect(clearLayerEffect).toHaveBeenCalledWith({ pieceId: "p1", layerId: "sc1", phase: "out" });
  });
});
