import { describe, it, expect, vi, beforeEach } from "vitest";

const fileRow = {
  id: "file-1",
  pieceId: "piece-1",
  filename: "clip.mp4",
  name: "clip.mp4",
  type: "video",
  mediaDuration: 8,
};
let currentRow: Record<string, unknown> | undefined = fileRow;

vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(currentRow ? [currentRow] : []),
        }),
      }),
    }),
  }),
}));

const runJobViaServer = vi.fn();
vi.mock("@/mcp/jobs-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mcp/jobs-client")>();
  return { ...actual, runJobViaServer: (...a: unknown[]) => runJobViaServer(...a) };
});

const engineInstalled = vi.fn(() => true);
vi.mock("@/lib/tracking/not-installed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tracking/not-installed")>();
  return { ...actual, trackingEngineInstalled: () => engineInstalled() };
});

import { removeBackground } from "@/mcp/tools/matte-tools";

beforeEach(() => {
  currentRow = fileRow;
  engineInstalled.mockReturnValue(true);
  runJobViaServer.mockReset();
});

describe("removeBackground", () => {
  it("enqueues matte_gen with deterministic params on the happy path", async () => {
    runJobViaServer.mockResolvedValue({
      status: "new",
      jobId: "job-1",
      clientKey: "ck",
      result: { cutoutFileId: "cut-1", frameCount: 90, framerate: 30, engine: "local", msPerFrame: 250 },
    });
    const res = await removeBackground({
      fileId: "file-1",
      subject: { kind: "box", box: [1, 2, 3, 4] },
    });
    expect(res.success).toBe(true);
    if (!res.success) throw new Error("unreachable"); // narrow the union for TS
    expect(res.data?.cutoutFileId).toBe("cut-1");
    const [kind, params] = runJobViaServer.mock.calls[0];
    expect(kind).toBe("matte_gen");
    expect(params).toEqual({
      fileId: "file-1",
      engine: "local",
      subject: { kind: "box", box: [1, 2, 3, 4] },
    });
  });

  it("engine fal returns the agent-driven redirect (never enqueues)", async () => {
    const res = await removeBackground({ fileId: "file-1", engine: "fal" });
    // toMatchObject keeps TS happy on the discriminated union (error only
    // exists on the failure branch).
    expect(res).toMatchObject({ success: false, error: "fal_engine_is_agent_driven" });
    expect(runJobViaServer).not.toHaveBeenCalled();
  });

  it("image files are routed to the fal photo path", async () => {
    currentRow = { ...fileRow, type: "image" };
    const res = await removeBackground({ fileId: "file-1" });
    expect(res).toMatchObject({ success: false, error: "local_image_matting_not_supported" });
  });

  it("kind box without a box is a validation error", async () => {
    const res = await removeBackground({ fileId: "file-1", subject: { kind: "box" } });
    expect(res).toMatchObject({ success: false, error: "subject_box_required" });
  });

  it("missing engine install returns the not-installed contract", async () => {
    engineInstalled.mockReturnValue(false);
    const res = await removeBackground({ fileId: "file-1" });
    expect(res).toMatchObject({ success: false, error: "dependency_not_ready" });
    expect(runJobViaServer).not.toHaveBeenCalled();
  });

  it("unknown file id fails cleanly", async () => {
    currentRow = undefined;
    const res = await removeBackground({ fileId: "nope" });
    expect(res.success).toBe(false);
    if (res.success) throw new Error("unreachable"); // narrow for TS
    expect(res.error).toContain("file not found");
  });
});
