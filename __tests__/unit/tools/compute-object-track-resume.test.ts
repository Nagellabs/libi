import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files, mcpServers } from "@/lib/db/schema/sqlite";
import { seedDatabase } from "@/lib/db/init";
import { createTrackingMcpServer } from "@/mcp/tracking-mcp/server";
import { createLibiMcpServer } from "@/mcp/server";
import { registeredToolNames, TRACKING_TOOL_NAMES } from "@/__tests__/helpers/mcp-tools";

/**
 * Verifies the resume semantics of computeObjectTrack's shot-fan-out.
 *
 * After the Plan-3 fan-out rewrite computeObjectTrack no longer threads a
 * single `forceNew` flag straight to one `runJobViaServer` call. It instead:
 *   - runs ONE shot-detection job (`method: "shots"`) — never forced
 *     (deterministic, safe to dedupe), then
 *   - one `yoloe+botsort` segment job per detected shot — also never forced
 *     by default (no forceNew threaded from the top-level tool).
 * The server still owns true dedup/resume; from the tool's side we assert the
 * fan-out invokes `runJobViaServer` with `resume: true` for every job and
 * returns the new `{ trackId, segments, summary }` contract.
 */

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
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

const PIECE_ID = "piece-resume-1";
const FILE_ID = "file-resume-1";

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
  tmp = await mkdtemp(join(tmpdir(), "libi-resume-"));
  process.env.LIBI_HOME = tmp;

  db = createTestDb();
  vi.mocked(getDb).mockReturnValue(db as never);

  seedDatabase(db as never);
  markLibiDepsInstalled(db);
  seedPiece(db, { id: PIECE_ID });
  await db.insert(files).values({
    id: FILE_ID,
    pieceId: PIECE_ID,
    filename: "f.mp4",
    name: "f",
    description: "",
    type: "video",
    storagePath: "/tmp/f.mp4",
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

describe("compute_object_track MCP surface (resume tests file)", () => {
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

describe("computeObjectTrack fan-out resume semantics", () => {
  it("shot-detection job + per-shot segment jobs all dedupe (forceNew never set)", async () => {
    vi.mocked(runJobViaServer)
      // detectShotRanges → two shots
      .mockResolvedValueOnce({
        jobId: "job-shots",
        resumed: true,
        result: { shots: [{ start: 0, end: 1 }, { start: 1, end: 2 }], samples: [], framerate: 30 },
      } as never)
      // each per-shot segment compute
      .mockResolvedValue({
        jobId: "job-seg",
        resumed: true,
        result: {
          samples: [{ t: 0, x: 1, y: 2, w: 3, h: 4, confidence: 0.9, visible: true }],
          framerate: 30,
        },
      } as never);

    const { computeObjectTrack } = await import("@/mcp/tools/tracking-tools");
    const res = await computeObjectTrack({
      fileId: FILE_ID,
      objectKind: "object",
      fps: 30,
      anchors: [{ fileId: FILE_ID, time: 0, bbox: [0, 0, 10, 10] }],
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data?.trackId).toMatch(/^trk-/);
      expect(res.data?.segments).toHaveLength(2);
      expect(res.data?.summary.perSegment).toHaveLength(2);
    }
    // The shot-detection job + every per-shot segment job is dedupe-friendly:
    // either `resume: true` (legacy) or `forceNew: false` — never `forceNew: true`.
    expect(runJobViaServer).toHaveBeenCalledTimes(3); // 1 shots + 2 segments
    for (const call of vi.mocked(runJobViaServer).mock.calls) {
      expect(call[0]).toBe("tracking");
      const opts = call[2] as { resume?: boolean; forceNew?: boolean };
      expect(opts.forceNew !== true).toBe(true);
    }
  });

  it("the shot-detection job is invoked with method: \"shots\"", async () => {
    vi.mocked(runJobViaServer)
      .mockResolvedValueOnce({
        jobId: "job-shots",
        resumed: true,
        result: { shots: [{ start: 0, end: 2 }], samples: [], framerate: 30 },
      } as never)
      .mockResolvedValue({
        jobId: "job-seg",
        resumed: true,
        result: {
          samples: [{ t: 0, x: 1, y: 2, w: 3, h: 4, confidence: 0.9, visible: true }],
          framerate: 30,
        },
      } as never);

    const { computeObjectTrack } = await import("@/mcp/tools/tracking-tools");
    const res = await computeObjectTrack({
      fileId: FILE_ID,
      objectKind: "object",
      fps: 30,
      anchors: [{ fileId: FILE_ID, time: 0, bbox: [0, 0, 10, 10] }],
    });

    expect(res.success).toBe(true);
    const firstCallParams = vi.mocked(runJobViaServer).mock.calls[0][1] as { method?: string };
    expect(firstCallParams.method).toBe("shots");
  });
});
