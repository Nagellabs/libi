/**
 * Verifies the three end-state paths in computeObjectTrack after the Plan-3
 * shot fan-out rewrite. computeObjectTrack no longer returns the MediaPipe-era
 * { trackId, jobId, sampleCount, resumed } single-job shape — it now detects
 * shots and stitches one yoloe+botsort segment per shot, returning
 * { trackId, segments, summary }. Error propagation is unchanged: a
 * LibiServerUnavailableError / CancelledError thrown anywhere in the fan-out
 * (here: from the mocked runJobViaServer that detectShotRanges/
 * computeTrackSegment call) still surfaces as the same structured error shapes.
 *   1. Success → returns { trackId, segments[], summary } where each detected
 *      shot is a segment.
 *   2. LibiServerUnavailableError → returns
 *      { success: false, error: "libi_server_unavailable", data: { hint } }.
 *   3. CancelledError → returns
 *      { success: false, error: "cancelled", data: { jobId } }.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files, mcpServers } from "@/lib/db/schema/sqlite";
import { seedDatabase } from "@/lib/db/init";
import { createTrackingMcpServer } from "@/mcp/tracking-mcp/server";
import { createLibiMcpServer } from "@/mcp/server";
import { registeredToolNames, TRACKING_TOOL_NAMES } from "@/__tests__/helpers/mcp-tools";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

// Inline the class inside the factory — vi.mock is hoisted, so referencing
// a top-level binding would fail with "cannot access X before initialization".
// The tool uses `instanceof LibiServerUnavailableError`, so we must export
// the same class the tool gets at runtime.
vi.mock("@/mcp/jobs-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mcp/jobs-client")>();
  class LibiServerUnavailableError extends Error {
    readonly hint: string;
    constructor(message: string, hint: string) {
      super(message);
      this.name = "LibiServerUnavailableError";
      this.hint = hint;
    }
  }
  return {
    ...actual,
    runJobViaServer: vi.fn(),
    LibiServerUnavailableError,
  };
});

import { getDb } from "@/lib/db/client";
import { runJobViaServer, LibiServerUnavailableError } from "@/mcp/jobs-client";
import { CancelledError } from "@/lib/jobs/types";

const PIECE_ID = "piece-tt-1";
const FILE_ID = "file-tt-1";

function markLibiDepsInstalled(db: ReturnType<typeof createTestDb>) {
  db
    .update(mcpServers)
    .set({
      dependencyStatus: JSON.stringify([
        { binary: "tracking-pyenv", installed: true, runtimeStatus: "installed" },
      ]),
    })
    .where(eq(mcpServers.id, "libi"))
    .run();
}

let db: ReturnType<typeof createTestDb>;
let tmp: string;

beforeEach(async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  tmp = await mkdtemp(join(tmpdir(), "libi-tt-"));
  process.env.LIBI_HOME = tmp;

  db = createTestDb();
  vi.mocked(getDb).mockReturnValue(db as never);

  seedDatabase(db as never);
  markLibiDepsInstalled(db);
  seedPiece(db, { id: PIECE_ID });
  await db.insert(files).values({
    id: FILE_ID,
    pieceId: PIECE_ID,
    filename: "v.mp4",
    name: "v",
    description: "",
    type: "video",
    storagePath: "/tmp/v.mp4",
    size: 0,
  });
});

afterEach(async () => {
  resetTestDb();
  vi.mocked(runJobViaServer).mockReset();
  delete process.env.LIBI_HOME;
  const { rm } = await import("node:fs/promises");
  await rm(tmp, { recursive: true, force: true });
});

describe("compute_object_track MCP surface (compute paths file)", () => {
  it("libi.compute_object_track is registered on the libi-tracking MCP", () => {
    const names = registeredToolNames(createTrackingMcpServer());
    expect(names).toContain("libi.compute_object_track");
    for (const t of TRACKING_TOOL_NAMES) expect(names).toContain(t);
  });

  it("libi.compute_object_track IS registered on the core libi MCP (always-on)", () => {
    const names = registeredToolNames(createLibiMcpServer());
    expect(names).toContain("libi.compute_object_track");
    for (const t of TRACKING_TOOL_NAMES) expect(names).toContain(t);
  });
});

describe("computeObjectTrack post-fan-out paths", () => {
  const baseParams = {
    fileId: FILE_ID,
    objectKind: "object" as const,
    anchors: [{ fileId: FILE_ID, time: 0, bbox: [0, 0, 10, 10] as [number, number, number, number] }],
  };

  it("success path returns { trackId, segments[], summary } (one segment per shot)", async () => {
    // First runJobViaServer call = detectShotRanges (method:"shots") → shots.
    // Subsequent calls = per-shot segment compute → samples.
    vi.mocked(runJobViaServer)
      .mockResolvedValueOnce({
        jobId: "job-shots",
        resumed: false,
        result: { shots: [{ start: 0, end: 1 }, { start: 1, end: 2 }], samples: [], framerate: 30 },
      } as never)
      .mockResolvedValue({
        jobId: "job-seg",
        resumed: false,
        result: {
          samples: [{ t: 0, x: 1, y: 2, w: 3, h: 4, confidence: 0.9, visible: true }],
          framerate: 30,
        },
      } as never);

    const { computeObjectTrack } = await import("@/mcp/tools/tracking-tools");
    const res = await computeObjectTrack(baseParams);

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data?.trackId).toMatch(/^trk-/);
      expect(res.data?.segments).toHaveLength(2);
      expect(res.data?.summary.perSegment).toHaveLength(2);
    }
  });

  it("LibiServerUnavailableError → structured libi_server_unavailable error", async () => {
    vi.mocked(runJobViaServer).mockRejectedValue(
      new LibiServerUnavailableError(
        "fetch failed",
        "libi server not running on port 3001. Start it with `npx @nagellabs/libi`.",
      ),
    );

    const { computeObjectTrack } = await import("@/mcp/tools/tracking-tools");
    const res = await computeObjectTrack(baseParams);

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toBe("libi_server_unavailable");
      const data = res.data as { hint: string } | undefined;
      expect(data?.hint).toMatch(/libi server not running/);
    }
  });

  it("CancelledError → structured cancelled error with jobId", async () => {
    vi.mocked(runJobViaServer).mockRejectedValue(new CancelledError("job-cancelled-1"));

    const { computeObjectTrack } = await import("@/mcp/tools/tracking-tools");
    const res = await computeObjectTrack(baseParams);

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toBe("cancelled");
      const data = res.data as { jobId: string } | undefined;
      expect(data?.jobId).toBe("job-cancelled-1");
    }
  });
});

// Regression: lisa-13 24s cameraman-wobble. A standalone agent repair
// (libi.compute_track_segment) must land at provenance:"agent" so it
// authoritatively outranks the engine seed; the computeObjectTrack shot
// fan-out must keep its per-shot SEED at provenance:"engine". Before this,
// every agent repair tied the seed at "engine" and won only by a
// createdAt/span accident — at the seam the winner flipped to the wrong
// subject and catmull-rom overshoot produced the visible wobble.
describe("compute_track_segment provenance precedence", () => {
  const baseParams = {
    fileId: FILE_ID,
    objectKind: "object" as const,
    anchors: [{ fileId: FILE_ID, time: 0, bbox: [0, 0, 10, 10] as [number, number, number, number] }],
  };

  it("shot fan-out stamps engine; standalone repair stamps agent and outranks an even-newer wider engine seed", async () => {
    const { readTrack } = await import("@/lib/tracking/storage");
    const { computeObjectTrack, computeTrackSegment } = await import(
      "@/mcp/tools/tracking-tools"
    );

    // 1. Shot fan-out lays the SEED. detectShotRanges → one shot; then the
    //    per-shot compute returns the (wrong-subject) seed box at x=10.
    vi.mocked(runJobViaServer)
      .mockResolvedValueOnce({
        jobId: "job-shots",
        resumed: false,
        result: { shots: [{ start: 0, end: 5 }], samples: [], framerate: 30 },
      } as never)
      .mockResolvedValueOnce({
        jobId: "job-seed",
        resumed: false,
        result: {
          samples: [
            { t: 2, x: 10, y: 10, w: 8, h: 8, confidence: 0.9, visible: true },
          ],
          framerate: 30,
        },
      } as never);

    const seeded = await computeObjectTrack(baseParams);
    expect(seeded.success).toBe(true);
    const trackId = seeded.success ? seeded.data!.trackId : "";
    const afterSeed = await readTrack(PIECE_ID, trackId);
    expect(
      afterSeed?.segments?.every((s) => s.provenance === "engine"),
    ).toBe(true);

    // 2. Standalone agent repair over an overlapping window — no provenance
    //    passed (mirrors the libi.compute_track_segment registration path).
    //    Correct-subject box at x=200.
    vi.mocked(runJobViaServer).mockResolvedValueOnce({
      jobId: "job-repair",
      resumed: false,
      result: {
        samples: [
          { t: 2, x: 200, y: 200, w: 8, h: 8, confidence: 0.9, visible: true },
        ],
        framerate: 30,
      },
    } as never);

    const repair = await computeTrackSegment({
      fileId: FILE_ID,
      trackId,
      range: { start: 1, end: 3 },
      method: "yoloe+botsort",
      objectKind: "object",
      anchors: [
        { fileId: FILE_ID, time: 2, bbox: [200, 200, 8, 8] as [number, number, number, number] },
      ],
    });
    expect(repair.success).toBe(true);

    const afterRepair = await readTrack(PIECE_ID, trackId);
    const repairSeg = afterRepair?.segments?.find((s) => s.id === "seg-1000-3000");
    expect(repairSeg?.provenance).toBe("agent");

    // 3. Now re-run the SEED over the same window with an even NEWER
    //    createdAt and a WIDER span — both createdAt and span tiebreakers
    //    favor it, yet provenance (agent > engine) must still let the
    //    agent repair own the overlap. The derived stitch at t=2 = x=200.
    vi.mocked(runJobViaServer).mockResolvedValueOnce({
      jobId: "job-seed2",
      resumed: false,
      result: {
        samples: [
          { t: 2, x: 10, y: 10, w: 8, h: 8, confidence: 0.9, visible: true },
        ],
        framerate: 30,
      },
    } as never);
    await computeTrackSegment({
      fileId: FILE_ID,
      trackId,
      range: { start: 0, end: 5 },
      method: "yoloe+botsort",
      objectKind: "object",
      anchors: [],
      // internal seed path
      provenance: "engine",
    });

    const final = await readTrack(PIECE_ID, trackId);
    const at2 = final?.samples.find((s) => Math.abs(s.t - 2) < 1e-6);
    expect(at2?.x).toBe(200); // agent repair wins despite newer+wider engine seed
  });
});
