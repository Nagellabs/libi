/**
 * Integration test: computeObjectTrackProviders tool.
 *
 * Mirrors compute-object-track.test.ts setup, but exercises the providers
 * tool with a stubbed fal client and the tracking_provider runner kind.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files, mcpServers } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { seedDatabase } from "@/lib/db/init";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/test-mode", () => ({ isTestMode: vi.fn().mockReturnValue(false) }));

vi.mock("@/mcp/jobs-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mcp/jobs-client")>();
  return {
    ...actual,
    runJobViaServer: vi.fn(),
    LibiServerUnavailableError: class LibiServerUnavailableError extends Error {
      readonly hint: string;
      constructor(message: string, hint: string) {
        super(message);
        this.name = "LibiServerUnavailableError";
        this.hint = hint;
      }
    },
  };
});

import { getDb } from "@/lib/db/client";
import { runJobViaServer } from "@/mcp/jobs-client";

function markLibiDepsInstalled(db: ReturnType<typeof createTestDb>) {
  db
    .update(mcpServers)
    .set({
      dependencyStatus: JSON.stringify([
        { binary: "chromium", installed: true, runtimeStatus: "installed" },
        { binary: "mediapipe-vision", installed: true, runtimeStatus: "installed" },
        { binary: "ffmpeg", installed: true, runtimeStatus: "installed" },
        { binary: "ffprobe", installed: true, runtimeStatus: "installed" },
      ]),
    })
    .where(eq(mcpServers.id, "libi"))
    .run();
}

const PIECE_ID = "piece-prov-1";
const FILE_ID = "file-prov-1";
let db: ReturnType<typeof createTestDb>;
let tmp: string;

beforeEach(async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  tmp = await mkdtemp(join(tmpdir(), "libi-tracking-prov-"));
  process.env.LIBI_HOME = tmp;

  db = createTestDb();
  vi.mocked(getDb).mockReturnValue(db as never);

  seedDatabase(db as never);
  markLibiDepsInstalled(db);
  seedPiece(db, { id: PIECE_ID });
  await db.insert(files).values({
    id: FILE_ID,
    pieceId: PIECE_ID,
    filename: "a.mp4",
    name: "a",
    description: "",
    type: "video",
    storagePath: "/tmp/a.mp4",
    size: 0,
  });

  vi.mocked(runJobViaServer).mockResolvedValue({
    status: "new",
    jobId: "job-provider-1",
    clientKey: "ck-provider-1",
    result: {
      samples: [{ t: 0, x: 10, y: 20, w: 30, h: 40, confidence: 0.97, visible: true }],
      framerate: 30,
    },
  } as never);
});

afterEach(async () => {
  resetTestDb();
  delete process.env.LIBI_HOME;
  vi.mocked(runJobViaServer).mockReset();
  const { rm } = await import("node:fs/promises");
  await rm(tmp, { recursive: true, force: true });
});

describe("computeObjectTrackProviders tool", () => {
  it("inserts a track row + writes a JSON sidecar with method=sam2-fal", async () => {
    const { computeObjectTrackProviders } = await import("@/mcp/tools/tracking-tools");
    const result = await computeObjectTrackProviders({
      fileId: FILE_ID,
      objectKind: "face",
      label: "lisa",
      fps: 30,
      provider: "sam2-fal",
      anchors: [{ fileId: FILE_ID, time: 0, bbox: [10, 10, 50, 50] }],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data?.trackId).toMatch(/^trk-/);
      expect(result.data?.jobId).toBe("job-provider-1");
      expect(result.data?.resumed).toBe(false);
    }

    const { listTracksByFile } = await import("@/lib/tracking/repo");
    const rows = await listTracksByFile(db, FILE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("lisa");
    expect(rows[0].method).toBe("sam2-fal");

    const { readTrack } = await import("@/lib/tracking/storage");
    const t = await readTrack(PIECE_ID, rows[0].id);
    expect(t?.samples).toHaveLength(1);
    expect(t?.samples[0].x).toBe(10);
    expect(t?.anchors).toHaveLength(1);
    expect(t?.anchors?.[0].bbox).toEqual([10, 10, 50, 50]);
  });

  it("invokes tracking_provider runner kind via runJobViaServer", async () => {
    const { computeObjectTrackProviders } = await import("@/mcp/tools/tracking-tools");
    await computeObjectTrackProviders({
      fileId: FILE_ID,
      objectKind: "object",
      provider: "sam2-fal",
      anchors: [{ fileId: FILE_ID, time: 0, bbox: [5, 5, 20, 20] }],
    });

    expect(vi.mocked(runJobViaServer)).toHaveBeenCalledWith(
      "tracking_provider",
      expect.objectContaining({ provider: "sam2-fal", fileId: FILE_ID }),
      expect.any(Object),
    );
  });

  it("returns providers_disabled_in_test_mode when isTestMode() is true", async () => {
    const { isTestMode } = await import("@/lib/test-mode");
    vi.mocked(isTestMode).mockReturnValueOnce(true);

    const { computeObjectTrackProviders } = await import("@/mcp/tools/tracking-tools");
    const result = await computeObjectTrackProviders({
      fileId: FILE_ID,
      objectKind: "face",
      provider: "sam2-fal",
      anchors: [{ fileId: FILE_ID, time: 0, bbox: [0, 0, 10, 10] }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("providers_disabled_in_test_mode");
    }
    expect(vi.mocked(runJobViaServer)).not.toHaveBeenCalled();
  });

  it("rejects when file is unassigned to a piece", async () => {
    await db.insert(files).values({
      id: "global-prov-1",
      pieceId: null,
      filename: "g.mp4",
      name: "g",
      description: "",
      type: "video",
      storagePath: "/tmp/g.mp4",
      size: 0,
    });
    const { computeObjectTrackProviders } = await import("@/mcp/tools/tracking-tools");
    const result = await computeObjectTrackProviders({
      fileId: "global-prov-1",
      objectKind: "face",
      provider: "sam2-fal",
      anchors: [{ fileId: "global-prov-1", time: 0, bbox: [0, 0, 10, 10] }],
    });
    expect(result.success).toBe(false);
  });
});

// --- 4-shape RunJobResult contract (T17) -----------------------------------

/** Success-data shape of runTrackingCommon (mcp/tools/tracking-tools.ts),
 *  including the dedup markers the declared tool return type narrows away. */
type ProviderTrackData = {
  trackId: string;
  jobId: string;
  sampleCount: number;
  resumed: boolean;
  clientKey?: string;
  forced?: true;
  attachedToRunning?: true;
  matchedExisting?: true;
  existingJob?: { jobId: string; pieceId: string | null; startedAt?: string; completedAt?: string };
};

describe("computeObjectTrackProviders RunJobResult shapes", () => {
  it("status:'new' surfaces jobId + clientKey, no dedup markers", async () => {
    vi.mocked(runJobViaServer).mockReset();
    vi.mocked(runJobViaServer).mockResolvedValue({
      status: "new",
      jobId: "job-new",
      clientKey: "ck-new",
      result: {
        samples: [{ t: 0, x: 1, y: 2, w: 3, h: 4, confidence: 0.9, visible: true }],
        framerate: 30,
      },
    } as never);

    const { computeObjectTrackProviders } = await import("@/mcp/tools/tracking-tools");
    const r = await computeObjectTrackProviders({
      fileId: FILE_ID,
      objectKind: "object",
      provider: "sam2-fal",
      anchors: [{ fileId: FILE_ID, time: 0, bbox: [0, 0, 10, 10] }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as ProviderTrackData;
      expect(d.jobId).toBe("job-new");
      expect(d.clientKey).toBe("ck-new");
      expect(d.attachedToRunning).toBeUndefined();
      expect(d.matchedExisting).toBeUndefined();
      expect(d.resumed).toBe(false);
      expect(d.sampleCount).toBe(1);
    }
  });

  it("status:'new' + forced:true marks data.forced and forwards forceNew", async () => {
    vi.mocked(runJobViaServer).mockReset();
    vi.mocked(runJobViaServer).mockResolvedValue({
      status: "new",
      jobId: "job-forced",
      clientKey: "ck-forced",
      forced: true,
      result: {
        samples: [{ t: 0, x: 1, y: 2, w: 3, h: 4, confidence: 0.9, visible: true }],
        framerate: 30,
      },
    } as never);

    const { computeObjectTrackProviders } = await import("@/mcp/tools/tracking-tools");
    const r = await computeObjectTrackProviders({
      fileId: FILE_ID,
      objectKind: "object",
      provider: "sam2-fal",
      forceNew: true,
      anchors: [{ fileId: FILE_ID, time: 0, bbox: [0, 0, 10, 10] }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as ProviderTrackData;
      expect(d.forced).toBe(true);
      expect(d.attachedToRunning).toBeUndefined();
      expect(d.matchedExisting).toBeUndefined();
    }
    expect(vi.mocked(runJobViaServer)).toHaveBeenCalledWith(
      "tracking_provider",
      expect.any(Object),
      expect.objectContaining({ forceNew: true }),
    );
  });

  it("status:'attached_running' surfaces attachedToRunning + existingJob and persists track samples", async () => {
    vi.mocked(runJobViaServer).mockReset();
    vi.mocked(runJobViaServer).mockResolvedValue({
      status: "attached_running",
      jobId: "job-att",
      clientKey: "ck-att",
      existingJob: {
        jobId: "job-orig",
        pieceId: PIECE_ID,
        startedAt: "2026-05-21T10:00:00Z",
      },
      result: {
        samples: [{ t: 0, x: 7, y: 8, w: 9, h: 10, confidence: 0.8, visible: true }],
        framerate: 30,
      },
    } as never);

    const { computeObjectTrackProviders } = await import("@/mcp/tools/tracking-tools");
    const r = await computeObjectTrackProviders({
      fileId: FILE_ID,
      objectKind: "object",
      provider: "sam2-fal",
      anchors: [{ fileId: FILE_ID, time: 0, bbox: [0, 0, 10, 10] }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as ProviderTrackData;
      expect(d.attachedToRunning).toBe(true);
      expect(d.matchedExisting).toBeUndefined();
      expect(d.resumed).toBe(true);
      expect(d.jobId).toBe("job-att");
      expect(d.clientKey).toBe("ck-att");
      expect(d.existingJob).toEqual({
        jobId: "job-orig",
        pieceId: PIECE_ID,
        startedAt: "2026-05-21T10:00:00Z",
      });
      expect(d.sampleCount).toBe(1);
    }
  });

  it("status:'matching_completed' surfaces matchedExisting + existingJob (cached track)", async () => {
    vi.mocked(runJobViaServer).mockReset();
    vi.mocked(runJobViaServer).mockResolvedValue({
      status: "matching_completed",
      existingJob: {
        jobId: "job-cached",
        pieceId: PIECE_ID,
        completedAt: "2026-05-20T12:00:00Z",
        status: "completed",
        result: {
          samples: [
            { t: 0, x: 1, y: 1, w: 1, h: 1, confidence: 0.5, visible: true },
            { t: 1, x: 2, y: 2, w: 1, h: 1, confidence: 0.5, visible: true },
          ],
          framerate: 30,
        },
      },
    } as never);

    const { computeObjectTrackProviders } = await import("@/mcp/tools/tracking-tools");
    const r = await computeObjectTrackProviders({
      fileId: FILE_ID,
      objectKind: "object",
      provider: "sam2-fal",
      anchors: [{ fileId: FILE_ID, time: 0, bbox: [0, 0, 10, 10] }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as ProviderTrackData;
      expect(d.matchedExisting).toBe(true);
      expect(d.attachedToRunning).toBeUndefined();
      expect(d.jobId).toBe("job-cached");
      expect(d.sampleCount).toBe(2);
      expect(d.existingJob?.jobId).toBe("job-cached");

      // The returned trackId MUST be usable — i.e. the cached samples were
      // persisted under the new trackId (DB row + JSON sidecar). Without
      // this, add_tracked_overlay would fail with "track not found".
      const { getTrackRow } = await import("@/lib/tracking/repo");
      const row = await getTrackRow(db, d.trackId);
      expect(row).not.toBeNull();
      expect(row?.sampleCount).toBe(2);

      const { readTrack } = await import("@/lib/tracking/storage");
      const track = await readTrack(PIECE_ID, d.trackId);
      expect(track).not.toBeNull();
      expect(track?.samples.length).toBe(2);
    }
  });
});
