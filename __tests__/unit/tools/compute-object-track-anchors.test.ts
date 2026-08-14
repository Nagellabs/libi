import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ComputeObjectTrackSchema, ComputeObjectTrackProvidersSchema } from "@/mcp/tools/schemas";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files, mcpServers } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { seedDatabase } from "@/lib/db/init";
import { createTrackingMcpServer } from "@/mcp/tracking-mcp/server";
import { createLibiMcpServer } from "@/mcp/server";
import { registeredToolNames, TRACKING_TOOL_NAMES } from "@/__tests__/helpers/mcp-tools";

describe("compute_object_track anchors validation", () => {
  it("rejects calls without anchors, derivedFromSubjectName, or derivedFromItemName", () => {
    const r = ComputeObjectTrackSchema.safeParse({
      fileId: "x",
      objectKind: "face",
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty anchor arrays when no derivation params", () => {
    const r = ComputeObjectTrackSchema.safeParse({
      fileId: "x",
      objectKind: "face",
      anchors: [],
    });
    expect(r.success).toBe(false);
  });

  it("accepts 1-100 anchors", () => {
    for (const n of [1, 3, 5, 50, 100]) {
      const anchors = Array.from({ length: n }, (_, i) => ({
        fileId: "x",
        time: i * 5,
        bbox: [10, 20, 30, 40] as [number, number, number, number],
      }));
      const r = ComputeObjectTrackSchema.safeParse({
        fileId: "x",
        objectKind: "face",
        anchors,
      });
      expect(r.success).toBe(true);
    }
  });

  it("rejects 101+ anchors", () => {
    const anchors = Array.from({ length: 101 }, (_, i) => ({
      fileId: "x",
      time: i,
      bbox: [0, 0, 10, 10] as [number, number, number, number],
    }));
    expect(
      ComputeObjectTrackSchema.safeParse({
        fileId: "x",
        objectKind: "face",
        anchors,
      }).success,
    ).toBe(false);
  });

  it("accepts derivedFromSubjectName alone (no anchors)", () => {
    const r = ComputeObjectTrackSchema.safeParse({
      fileId: "x",
      objectKind: "face",
      derivedFromSubjectName: "Lisa",
    });
    expect(r.success).toBe(true);
  });

  it("accepts derivedFromItemName alone (no anchors)", () => {
    const r = ComputeObjectTrackSchema.safeParse({
      fileId: "x",
      objectKind: "object",
      derivedFromItemName: "product-box",
    });
    expect(r.success).toBe(true);
  });

  it("accepts both anchors AND derivedFromSubjectName", () => {
    const r = ComputeObjectTrackSchema.safeParse({
      fileId: "x",
      objectKind: "face",
      anchors: [{ fileId: "x", time: 0, bbox: [10, 20, 30, 40] }],
      derivedFromSubjectName: "Lisa",
    });
    expect(r.success).toBe(true);
  });

  it("rejects bbox with wrong arity", () => {
    for (const bbox of [[0, 0, 10], [0, 0, 10, 10, 10]] as unknown[]) {
      expect(
        ComputeObjectTrackSchema.safeParse({
          fileId: "x",
          objectKind: "face",
          anchors: [{ fileId: "x", time: 0, bbox }],
        }).success,
      ).toBe(false);
    }
  });

  it("rejects bbox with non-numeric values", () => {
    expect(
      ComputeObjectTrackSchema.safeParse({
        fileId: "x",
        objectKind: "face",
        anchors: [{ fileId: "x", time: 0, bbox: ["0", 0, 0, 0] }],
      }).success,
    ).toBe(false);
  });

  it("does not accept a provider field (provider was removed from this tool)", () => {
    // ComputeObjectTrackSchema strips unknown keys — parse succeeds but
    // the resulting object must not contain a provider property.
    const result = ComputeObjectTrackSchema.safeParse({
      fileId: "x",
      objectKind: "face",
      anchors: [{ fileId: "x", time: 0, bbox: [0, 0, 10, 10] }],
      provider: "sam2-fal",
    });
    // Zod strips unknown keys by default so parse may succeed, but provider
    // must not be on the output type.
    if (result.success) {
      expect((result.data as Record<string, unknown>).provider).toBeUndefined();
    }
  });
});

describe("ComputeObjectTrackProvidersSchema validation", () => {
  it("requires provider field", () => {
    const r = ComputeObjectTrackProvidersSchema.safeParse({
      fileId: "x",
      objectKind: "face",
      anchors: [{ fileId: "x", time: 0, bbox: [0, 0, 10, 10] }],
    });
    expect(r.success).toBe(false);
  });

  it("accepts provider: sam2-fal", () => {
    const r = ComputeObjectTrackProvidersSchema.safeParse({
      fileId: "x",
      objectKind: "face",
      anchors: [{ fileId: "x", time: 0, bbox: [0, 0, 10, 10] }],
      provider: "sam2-fal",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.provider).toBe("sam2-fal");
  });

  it("rejects unknown provider values", () => {
    const r = ComputeObjectTrackProvidersSchema.safeParse({
      fileId: "x",
      objectKind: "face",
      anchors: [{ fileId: "x", time: 0, bbox: [0, 0, 10, 10] }],
      provider: "unknown-provider",
    });
    expect(r.success).toBe(false);
  });

  it("rejects calls without anchors or derivation params", () => {
    const r = ComputeObjectTrackProvidersSchema.safeParse({
      fileId: "x",
      objectKind: "face",
      provider: "sam2-fal",
    });
    expect(r.success).toBe(false);
  });

  it("accepts derivedFromSubjectName without anchors", () => {
    const r = ComputeObjectTrackProvidersSchema.safeParse({
      fileId: "x",
      objectKind: "face",
      provider: "sam2-fal",
      derivedFromSubjectName: "Lisa",
    });
    expect(r.success).toBe(true);
  });
});

describe("compute_object_track + compute_object_track_providers MCP surface", () => {
  it("both tools are registered on the libi-tracking MCP", () => {
    const names = registeredToolNames(createTrackingMcpServer());
    expect(names).toContain("libi.compute_object_track");
    expect(names).toContain("libi.compute_object_track_providers");
  });

  it("both tools ARE registered on the core libi MCP (always-on)", () => {
    const names = registeredToolNames(createLibiMcpServer());
    expect(names).toContain("libi.compute_object_track");
    expect(names).toContain("libi.compute_object_track_providers");
  });

  it("libi-tracking MCP registers all 12 tracking tools", () => {
    const names = registeredToolNames(createTrackingMcpServer());
    for (const t of TRACKING_TOOL_NAMES) expect(names).toContain(t);
  });
});

describe("computeObjectTrack dep gating", () => {
  const PIECE_ID = "piece-dep-1";
  const FILE_ID = "file-dep-1";
  let db: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    db = createTestDb();
    seedDatabase(db as never);
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
  });

  afterEach(() => {
    resetTestDb();
    vi.restoreAllMocks();
  });

  // Post-Plan-3 the engine pipeline (shot detection + yoloe+botsort) replaces
  // the MediaPipe/Chromium path, so the dep gate is now `tracking-pyenv`
  // (uv venv + ONNX models), not chromium/mediapipe-vision.
  it("returns dependency_not_ready when tracking-pyenv is still installing", async () => {
    db
      .update(mcpServers)
      .set({
        dependencyStatus: JSON.stringify([
          {
            binary: "tracking-pyenv",
            installed: false,
            runtimeStatus: "installing",
            bytesDownloaded: 50,
            bytesTotal: 100,
          },
        ]),
      })
      .where(eq(mcpServers.id, "libi"))
      .run();

    const { computeObjectTrack } = await import("@/mcp/tools/tracking-tools");
    const result = await computeObjectTrack({
      fileId: FILE_ID,
      objectKind: "object",
      anchors: [{ fileId: FILE_ID, time: 0, bbox: [10, 10, 50, 50] }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("dependency_not_ready");
      const data = result.data as
        | { missing: Array<{ binary: string; runtimeStatus: string }> }
        | undefined;
      expect(data?.missing[0].binary).toBe("tracking-pyenv");
      expect(data?.missing[0].runtimeStatus).toBe("installing");
    }
  });

  it("returns dependency_not_ready when tracking-pyenv is missing entirely from a present libi row", async () => {
    db
      .update(mcpServers)
      .set({
        dependencyStatus: JSON.stringify([
          { binary: "ffmpeg", installed: true, runtimeStatus: "installed" },
        ]),
      })
      .where(eq(mcpServers.id, "libi"))
      .run();

    const { computeObjectTrack } = await import("@/mcp/tools/tracking-tools");
    const result = await computeObjectTrack({
      fileId: FILE_ID,
      objectKind: "object",
      anchors: [{ fileId: FILE_ID, time: 0, bbox: [10, 10, 50, 50] }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("dependency_not_ready");
      const data = result.data as
        | { missing: Array<{ binary: string }> }
        | undefined;
      expect(data?.missing.map((m) => m.binary)).toEqual(["tracking-pyenv"]);
    }
  });
});
