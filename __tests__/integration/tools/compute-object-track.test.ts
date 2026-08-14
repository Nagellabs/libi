import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files, mcpServers } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { seedDatabase } from "@/lib/db/init";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/test-mode", () => ({ isTestMode: vi.fn().mockReturnValue(false) }));

// Mock the HTTP boundary — runJobViaServer is the seam between the MCP tool
// and the Next.js JobManager. Returning a stub result lets us exercise the
// tool's downstream side effects (track row insert, JSON sidecar write).
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
import { runJobViaServer, type RunJobResult } from "@/mcp/jobs-client";

function markLibiDepsInstalled(db: ReturnType<typeof createTestDb>) {
  db
    .update(mcpServers)
    .set({
      dependencyStatus: JSON.stringify([
        { binary: "tracking-pyenv", installed: true, runtimeStatus: "installed" },
        { binary: "ffmpeg", installed: true, runtimeStatus: "installed" },
        { binary: "ffprobe", installed: true, runtimeStatus: "installed" },
      ]),
    })
    .where(eq(mcpServers.id, "libi"))
    .run();
}

const PIECE_ID = "piece-cmp-1";
const FILE_ID = "file-cmp-1";
let db: ReturnType<typeof createTestDb>;
let tmp: string;

beforeEach(async () => {
  // Fresh tmp dir for the JSON sidecar.
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  tmp = await mkdtemp(join(tmpdir(), "libi-tracking-"));
  process.env.LIBI_HOME = tmp;

  db = createTestDb();
  vi.mocked(getDb).mockReturnValue(db as never);

  // Seed the libi MCP row, then mark its deps installed so requireDeps lets
  // computeObjectTrack proceed. Without this the tool short-circuits with
  // "dependency_not_ready" before it ever reaches the runner.
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

  // Default mock: first call = shot detection (one whole-clip shot),
  // subsequent calls = the per-shot segment compute (single sample).
  vi.mocked(runJobViaServer)
    .mockResolvedValueOnce({
      jobId: "job-shots-1",
      resumed: false,
      result: { shots: [{ start: 0, end: 1 }], samples: [], framerate: 30 },
      // Deliberately a partial stub (no `status` discriminant) — the tool only
      // reads `jobId` + `result` off the non-`matching_completed` branches.
    } as unknown as RunJobResult<unknown>)
    .mockResolvedValue({
      jobId: "job-tracking-1",
      resumed: false,
      result: {
        samples: [{ t: 0, x: 10, y: 20, w: 30, h: 40, confidence: 0.9, visible: true }],
        framerate: 30,
      },
    } as unknown as RunJobResult<unknown>);
});

afterEach(async () => {
  resetTestDb();
  delete process.env.LIBI_HOME;
  vi.mocked(runJobViaServer).mockReset();
  const { rm } = await import("node:fs/promises");
  await rm(tmp, { recursive: true, force: true });
});

describe("computeObjectTrack tool (shot fan-out)", () => {
  it("fans out one segment per shot, inserts a segmented track row + JSON sidecar", async () => {
    const { computeObjectTrack } = await import("@/mcp/tools/tracking-tools");
    const result = await computeObjectTrack({
      fileId: FILE_ID,
      objectKind: "object",
      label: "lisa",
      fps: 30,
      anchors: [{ fileId: FILE_ID, time: 0, bbox: [10, 10, 50, 50] }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data?.trackId).toMatch(/^trk-/);
      // One detected shot → one segment in the stitched track.
      expect(result.data?.segments).toHaveLength(1);
      expect(result.data?.summary.perSegment).toHaveLength(1);
    }

    const { listTracksByFile } = await import("@/lib/tracking/repo");
    const rows = await listTracksByFile(db, FILE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("lisa");

    const { readTrack } = await import("@/lib/tracking/storage");
    const t = await readTrack(PIECE_ID, rows[0].id);
    expect(t?.samples).toHaveLength(1);
    expect(t?.samples[0].x).toBe(10);
    // Segmented: the per-shot segment is recorded on the sidecar.
    expect(t?.segments).toHaveLength(1);

    expect(t?.anchors).toBeDefined();
    expect(t?.anchors).toHaveLength(1);
    // Bbox + fileId + time match what was passed in
    expect(t?.anchors?.[0].fileId).toBe(FILE_ID);
    expect(t?.anchors?.[0].bbox).toEqual([10, 10, 50, 50]);
  });

  it("rejects when file is unassigned to a piece", async () => {
    // Insert a global (unassigned) file
    await db.insert(files).values({
      id: "global-file-1",
      pieceId: null,
      filename: "g.mp4",
      name: "g",
      description: "",
      type: "video",
      storagePath: "/tmp/g.mp4",
      size: 0,
    });
    const { computeObjectTrack } = await import("@/mcp/tools/tracking-tools");
    const result = await computeObjectTrack({
      fileId: "global-file-1",
      objectKind: "face",
      anchors: [{ fileId: "global-file-1", time: 0, bbox: [0, 0, 10, 10] }],
    });
    expect(result.success).toBe(false);
  });
});

describe("computeObjectTrackProviders tool — sam2-fal path", () => {
  it("writes sqlite track row + JSON sidecar with method=sam2-fal", async () => {
    // Providers path is single-job (runTrackingCommon) — clear the beforeEach
    // fan-out mock queue (shots-first) so its one call gets the sam2 result.
    vi.mocked(runJobViaServer).mockReset();
    vi.mocked(runJobViaServer).mockResolvedValueOnce({
      status: "new",
      jobId: "job-sam2-1",
      clientKey: "ck-sam2-1",
      result: {
        samples: [
          { t: 0, x: 5, y: 10, w: 30, h: 40, confidence: 0.97, visible: true, subjectId: null },
          { t: 0.033, x: 6, y: 11, w: 31, h: 41, confidence: 0.96, visible: true, subjectId: null },
          { t: 0.067, x: 7, y: 12, w: 32, h: 42, confidence: 0.95, visible: true, subjectId: null },
        ],
        framerate: 30,
      },
    } as never);

    const { computeObjectTrackProviders } = await import("@/mcp/tools/tracking-tools");
    const result = await computeObjectTrackProviders({
      fileId: FILE_ID,
      objectKind: "object",
      label: "product",
      fps: 30,
      provider: "sam2-fal",
      anchors: [{ fileId: FILE_ID, time: 0, bbox: [5, 10, 30, 40] }],
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");

    expect(result.data?.jobId).toBe("job-sam2-1");
    expect(result.data?.sampleCount).toBe(3);
    expect(result.data?.trackId).toMatch(/^trk-/);

    const { getTrackRow } = await import("@/lib/tracking/repo");
    const row = await getTrackRow(db, result.data!.trackId);
    expect(row).not.toBeNull();
    expect(row?.method).toBe("sam2-fal");
    expect(row?.label).toBe("product");

    const { readTrack } = await import("@/lib/tracking/storage");
    const sidecar = await readTrack(PIECE_ID, result.data!.trackId);
    expect(sidecar?.samples).toHaveLength(3);
    expect(sidecar?.samples[0].x).toBe(5);
    expect(sidecar?.samples[0].y).toBe(10);
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
    // runJobViaServer must NOT have been called
    expect(vi.mocked(runJobViaServer)).not.toHaveBeenCalled();
  });
});
