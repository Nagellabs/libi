import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod/v3";
import { createTestDb, seedPiece } from "../../helpers/test-db";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

// `assertLoopbackOrPublicHttpUrl` falls through to `assertPublicHttpUrl` for
// anything that isn't loopback-on-our-own-port, which resolves DNS. Stub the
// resolver so these tests control what's "public" vs "private" without
// touching the real network.
const lookupMock = vi.fn();
vi.mock("node:dns", () => ({
  promises: { lookup: (...args: unknown[]) => lookupMock(...args) },
}));

import { getDb } from "@/lib/db/client";
import {
  __resetRunnerRegistryForTests,
  registerRunner,
} from "@/lib/jobs/runners/registry";
import { JobManager } from "@/lib/jobs/manager";
import { files } from "@/lib/db/schema/sqlite";

describe("POST /api/tracking/run", () => {
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
    delete (globalThis as { __libiJobManager?: unknown }).__libiJobManager;
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: "203.0.113.10", family: 4 }]);
    delete process.env.LIBI_PORT;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.LIBI_PORT;
  });

  function installMgr(): JobManager {
    const mgr = new JobManager();
    (globalThis as { __libiJobManager?: unknown }).__libiJobManager = mgr;
    return mgr;
  }

  /** A stub "tracking"-kind runner so the route's plumbing is exercised
   *  without pulling in the real mediapipe/Chromium/engine pipeline. */
  function registerStubTrackingRunner() {
    registerRunner({
      kind: "tracking",
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({
        fileId: z.string(),
        pieceId: z.string(),
        fileUrl: z.string(),
        fps: z.number(),
        objectKind: z.string(),
        anchors: z.array(z.unknown()),
      }),
      async run() {
        return { samples: [], framerate: 30 };
      },
    });
  }

  function seedFixtures(db: ReturnType<typeof createTestDb>) {
    seedPiece(db as never, { id: "p1", name: "Piece 1" });
    db.insert(files)
      .values({
        id: "f1",
        pieceId: "p1",
        filename: "a.mp4",
        name: "a.mp4",
        description: "",
        type: "video",
        storagePath: "p1/a.mp4",
      })
      .run();
  }

  const baseBody = {
    pieceId: "p1",
    fileId: "f1",
    fps: 30,
    objectKind: "face" as const,
    anchors: [{ fileId: "f1", time: 0, bbox: [0, 0, 1, 1] }],
  };

  it("returns 400 when a public fileUrl resolves to a private address", async () => {
    // The hostname looks public but its DNS answer is a private/metadata
    // address — the classic rebinding/SSRF shape this guard exists for.
    lookupMock.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);

    const db = vi.mocked(getDb)();
    seedFixtures(db);
    registerStubTrackingRunner();
    const mgr = installMgr();
    const enqueueSpy = vi.spyOn(mgr, "enqueue");

    const { POST } = await import("@/app/api/tracking/run/route");
    const res = await POST(
      new Request("http://x/api/tracking/run", {
        method: "POST",
        body: JSON.stringify({
          ...baseBody,
          fileUrl: "http://sneaky-metadata.example/video.mp4",
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/invalid fileUrl/);
    expect(json.error).toMatch(/private/);
    // The bad url must be rejected BEFORE a job is ever enqueued.
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("succeeds with a loopback fileUrl on the app's own port (the legitimate internal caller's shape)", async () => {
    // No LIBI_PORT set → getCurrentPort() falls back to the documented
    // default (3456), same fallback the route itself uses.
    const db = vi.mocked(getDb)();
    seedFixtures(db);
    registerStubTrackingRunner();
    installMgr();

    const { POST } = await import("@/app/api/tracking/run/route");
    const res = await POST(
      new Request("http://x/api/tracking/run", {
        method: "POST",
        body: JSON.stringify({
          ...baseBody,
          fileUrl: "http://127.0.0.1:3456/api/files/by-id/f1/content",
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("new");
    expect(json.result).toEqual({ samples: [], framerate: 30 });
    // The loopback shape never touches DNS — it's a literal IP match.
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("rejects a loopback url on the WRONG port (not our own app's port)", async () => {
    const db = vi.mocked(getDb)();
    seedFixtures(db);
    registerStubTrackingRunner();
    const mgr = installMgr();
    const enqueueSpy = vi.spyOn(mgr, "enqueue");

    const { POST } = await import("@/app/api/tracking/run/route");
    const res = await POST(
      new Request("http://x/api/tracking/run", {
        method: "POST",
        body: JSON.stringify({
          ...baseBody,
          fileUrl: "http://127.0.0.1:9999/api/files/by-id/f1/content",
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(res.status).toBe(400);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("returns 400 for missing required fields before any guard/enqueue logic runs", async () => {
    const db = vi.mocked(getDb)();
    seedFixtures(db);
    registerStubTrackingRunner();
    installMgr();

    const { POST } = await import("@/app/api/tracking/run/route");
    const res = await POST(
      new Request("http://x/api/tracking/run", {
        method: "POST",
        body: JSON.stringify({ pieceId: "p1" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });
});
