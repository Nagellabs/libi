import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/export/render-jobs", () => ({
  recordRenderProgress: vi.fn(),
}));

import { recordRenderProgress } from "@/lib/export/render-jobs";

describe("/api/export/render-progress/[id]/[token]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls recordRenderProgress with the body fields", async () => {
    const { POST } = await import("@/app/api/export/render-progress/[id]/[token]/route");
    const req = new Request("http://x/api/export/render-progress/jobX/tokY", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ done: 30, total: 300 }),
    });
    const res = await POST(req, {
      params: Promise.resolve({ id: "jobX", token: "tokY" }),
    });
    expect(res.status).toBe(200);
    expect(recordRenderProgress).toHaveBeenCalledWith("jobX", "tokY", 30, 300);
  });

  it("rejects malformed body with 400", async () => {
    const { POST } = await import("@/app/api/export/render-progress/[id]/[token]/route");
    const req = new Request("http://x/api/export/render-progress/jobX/tokY", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req, {
      params: Promise.resolve({ id: "jobX", token: "tokY" }),
    });
    expect(res.status).toBe(400);
  });
});
