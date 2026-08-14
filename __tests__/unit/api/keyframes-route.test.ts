/**
 * Route-handler tests for the keyframe REST route
 * (app/api/pieces/[pieceId]/overlays/[overlayId]/keyframes/route.ts).
 *
 * The handlers delegate to the MCP tool functions; the route's own job is the
 * HTTP mapping: 404 when the tool reports the overlay is "not found", 400 for
 * other tool failures + invalid bodies, 200 on success (refresh fired). We mock
 * the tool layer so the assertions are about that mapping, not the tool logic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const addKeyframe = vi.fn();
const deleteKeyframe = vi.fn();
const setKeyframeEasing = vi.fn();

vi.mock("@/mcp/tools/overlay-tools", () => ({
  addKeyframe: (...a: unknown[]) => addKeyframe(...a),
  deleteKeyframe: (...a: unknown[]) => deleteKeyframe(...a),
  setKeyframeEasing: (...a: unknown[]) => setKeyframeEasing(...a),
}));

const emit = vi.fn();
vi.mock("@/lib/navigation-events", () => ({
  navigationEmitter: { emit: (...a: unknown[]) => emit(...a) },
}));

// readVersion loads the manifest; return a benign empty manifest.
vi.mock("@/lib/composition/persistence", () => ({
  loadManifest: async () => ({ overlays: [] }),
}));

import { POST, DELETE, PATCH } from "@/app/api/pieces/[pieceId]/overlays/[overlayId]/keyframes/route";

const params = Promise.resolve({ pieceId: "p1", overlayId: "ov1" });

function jsonReq(body: unknown, method = "POST") {
  return new Request("http://x/api/pieces/p1/overlays/ov1/keyframes", {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  addKeyframe.mockReset();
  deleteKeyframe.mockReset();
  setKeyframeEasing.mockReset();
  emit.mockReset();
});

describe("keyframes route — HTTP status mapping", () => {
  it("POST success → 200 and fires the refresh", async () => {
    addKeyframe.mockResolvedValue({ success: true, data: { overlayId: "ov1" } });
    const res = await POST(jsonReq({ time: 1 }), { params });
    expect(res.status).toBe(200);
    expect(emit).toHaveBeenCalledWith("refresh_query", {
      queryKey: "composition",
      pieceId: "p1",
    });
  });

  it("POST tool 'not found' failure → 404", async () => {
    addKeyframe.mockResolvedValue({ success: false, error: "overlay ov1 not found" });
    const res = await POST(jsonReq({ time: 1 }), { params });
    expect(res.status).toBe(404);
    expect(emit).not.toHaveBeenCalled();
  });

  it("POST other tool failure → 400", async () => {
    addKeyframe.mockResolvedValue({
      success: false,
      error: "time 5s is out of range for overlay window [0, 4]s",
    });
    const res = await POST(jsonReq({ time: 5 }), { params });
    expect(res.status).toBe(400);
  });

  it("POST invalid body (missing time) → 400, tool never called", async () => {
    const res = await POST(jsonReq({ properties: { opacity: 0.5 } }), { params });
    expect(res.status).toBe(400);
    expect(addKeyframe).not.toHaveBeenCalled();
  });

  it("PATCH 'no keyframe at time' failure → 400 (not 404)", async () => {
    setKeyframeEasing.mockResolvedValue({ success: false, error: "no keyframe at 1s" });
    const res = await PATCH(jsonReq({ time: 1, easing: "ease-in-out" }, "PATCH"), { params });
    expect(res.status).toBe(400);
  });

  it("DELETE accepts a ?time= query param and maps success → 200", async () => {
    deleteKeyframe.mockResolvedValue({ success: true, data: { overlayId: "ov1" } });
    const req = new Request("http://x/api/pieces/p1/overlays/ov1/keyframes?time=2", {
      method: "DELETE",
    });
    const res = await DELETE(req, { params });
    expect(res.status).toBe(200);
    expect(deleteKeyframe).toHaveBeenCalledWith(
      expect.objectContaining({ time: 2, pieceId: "p1", overlayId: "ov1" }),
    );
  });
});
