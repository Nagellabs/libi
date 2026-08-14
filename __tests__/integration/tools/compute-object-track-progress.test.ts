import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files, mcpServers } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { seedDatabase } from "@/lib/db/init";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

// Mock the HTTP boundary — the tool now calls runJobViaServer instead of
// driving JobManager in-process. We simulate the SSE side-channel by having
// the mock invoke `extra.sendNotification` directly, mirroring what the real
// runJobViaServer does when it sees a `progress` SSE frame.
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
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types";

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

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

let tmp: string;

beforeEach(async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  tmp = await mkdtemp(join(tmpdir(), "libi-tracking-progress-"));
  process.env.LIBI_HOME = tmp;
});

afterEach(async () => {
  resetTestDb();
  delete process.env.LIBI_HOME;
  vi.mocked(runJobViaServer).mockReset();
  const { rm } = await import("node:fs/promises");
  await rm(tmp, { recursive: true, force: true });
});

function setupDb(pieceId: string, fileId: string) {
  const db = createTestDb();
  vi.mocked(getDb).mockReturnValue(db as never);
  seedDatabase(db as never);
  markLibiDepsInstalled(db);
  seedPiece(db, { id: pieceId });
  db.insert(files).values({
    id: fileId,
    pieceId,
    filename: "v.mp4",
    name: "v",
    description: "",
    type: "video",
    storagePath: `${pieceId}/v.mp4`,
    contentType: "video/mp4",
    size: 1024,
  }).run();
  return db;
}

describe("compute_object_track forwards progress via MCP notification", () => {
  it("sends notifications/progress with the client's progressToken", async () => {
    setupDb("p1", "f1");

    // Simulate what runJobViaServer does internally: when it sees SSE
    // `progress` frames it fans them out to extra.sendNotification using the
    // same payload shape as lib/jobs/progress-forwarder.ts. We mirror that here
    // so the tool's behavior end-to-end is exercised even though we mocked the
    // HTTP boundary. Post-Plan-3 computeObjectTrack fans out: the first
    // runJobViaServer call is the shot-detection job (must carry `shots`),
    // every subsequent call is a per-shot segment compute (forwards progress).
    let callIdx = 0;
    vi.mocked(runJobViaServer).mockImplementation((async (_kind: string, _params: unknown, opts?: unknown) => {
      const isShots = callIdx++ === 0;
      const o = opts as {
        extra?: {
          _meta?: { progressToken?: string | number };
          sendNotification?: (notification: {
            method: string;
            params: Record<string, unknown>;
          }) => Promise<void>;
        };
      };
      const tok = o.extra?._meta?.progressToken;
      const send = o.extra?.sendNotification;
      if (!isShots && tok !== undefined && send) {
        await send({
          method: "notifications/progress",
          params: { progressToken: tok, progress: 60, total: 300, message: "60/300 frames" },
        });
        await send({
          method: "notifications/progress",
          params: { progressToken: tok, progress: 180, total: 300, message: "180/300 frames" },
        });
        await send({
          method: "notifications/progress",
          params: { progressToken: tok, progress: 300, total: 300, message: "300/300 frames" },
        });
      }
      return {
        jobId: isShots ? "job-shots" : "job-1",
        resumed: false,
        result: isShots
          ? { shots: [{ start: 0, end: 1 }], samples: [], framerate: 30 }
          : { samples: [], framerate: 30 },
      };
    }) as unknown as typeof runJobViaServer);

    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const extra = {
      _meta: { progressToken: "client-tok-1" },
      sendNotification,
      requestId: "req-1",
    } as unknown as ToolExtra;

    const { computeObjectTrack } = await import("@/mcp/tools/tracking-tools");
    const res = await computeObjectTrack(
      {
        fileId: "f1",
        objectKind: "face",
        anchors: [{ fileId: "f1", time: 0, bbox: [0, 0, 10, 10] }],
      },
      extra,
    );
    expect(res.success).toBe(true);

    expect(sendNotification).toHaveBeenCalled();
    const call = sendNotification.mock.calls[0][0];
    expect(call.method).toBe("notifications/progress");
    expect(call.params.progressToken).toBe("client-tok-1");
    expect(typeof call.params.progress).toBe("number");
    expect(typeof call.params.total).toBe("number");
  });

  it("works without progressToken (no notifications fired)", async () => {
    setupDb("p2", "f2");

    vi.mocked(runJobViaServer)
      .mockResolvedValueOnce({
        jobId: "job-shots-2",
        resumed: false,
        result: { shots: [{ start: 0, end: 1 }], samples: [], framerate: 30 },
      } as never)
      .mockResolvedValue({
        jobId: "job-2",
        resumed: false,
        result: { samples: [], framerate: 30 },
      } as never);

    const sendNotification = vi.fn();
    const extra = { _meta: {}, sendNotification, requestId: "req-2" } as unknown as ToolExtra;

    const { computeObjectTrack } = await import("@/mcp/tools/tracking-tools");
    const res = await computeObjectTrack(
      {
        fileId: "f2",
        objectKind: "face",
        anchors: [{ fileId: "f2", time: 0, bbox: [0, 0, 10, 10] }],
      },
      extra,
    );
    expect(res.success).toBe(true);
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
