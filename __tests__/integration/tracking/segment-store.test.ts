/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { pieces, files } from "@/lib/db/schema/sqlite";
import { saveTrackSamples } from "@/lib/tracking/save-track";
import { upsertSegment } from "@/lib/tracking/segment-store";
import { readTrack } from "@/lib/tracking/storage";
import { createTrackingMcpServer } from "@/mcp/tracking-mcp/server";
import { createLibiMcpServer } from "@/mcp/server";
import { registeredToolNames, TRACKING_TOOL_NAMES } from "@/__tests__/helpers/mcp-tools";

describe("segment-store backing tools — MCP surface", () => {
  it("tools backed by the segment store are on the libi-tracking MCP", () => {
    const names = registeredToolNames(createTrackingMcpServer());
    // compute_track_segment and skip_segment both write through the segment store
    expect(names).toContain("libi.compute_track_segment");
    expect(names).toContain("libi.skip_segment");
    expect(names).toContain("libi.list_track_segments");
    for (const t of TRACKING_TOOL_NAMES) expect(names).toContain(t);
  });

  it("segment-store-backed tools ARE on the core libi MCP (always-on)", () => {
    const names = registeredToolNames(createLibiMcpServer());
    expect(names).toContain("libi.compute_track_segment");
    expect(names).toContain("libi.skip_segment");
    expect(names).toContain("libi.list_track_segments");
  });
});

describe("upsertSegment", () => {
  beforeEach(async () => {
    createTestDb(); await createTempStorageDir();
    const { getDb } = await import("@/lib/db/client"); const db = getDb();
    await db.insert(pieces).values({ id: "p", name: "P", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(files).values({ id: "f", pieceId: "p", filename: "v.mp4", contentType: "video/mp4", createdAt: new Date(), mediaWidth: 100, mediaHeight: 100, mediaDuration: 10, name: "v", description: "", type: "video", storagePath: "p/v.mp4" } as any);
    await saveTrackSamples({ trackId: "trk", fileId: "f", framerate: 1, method: "yoloe+botsort",
      samples: [{ t: 0, x: 1, y: 1, w: 5, h: 5, confidence: 1, visible: true }] });
  });
  afterEach(() => { resetTestDb(); cleanupTempDir(); });

  it("task-39: a recompute over a marginally-different range REPLACES the failed engine segment (no overlap survives, lost samples cannot resurrect)", async () => {
    // Seed the incident shape: the shot fan-out persisted an all-lost engine
    // segment [0, 18.933] (samples exist, 0 visible)…
    const lost = Array.from({ length: 20 }, (_, i) => ({
      t: i * 0.947, x: 0, y: 0, w: 0, h: 0, confidence: 0, visible: false,
    }));
    await upsertSegment("trk", {
      id: "seg-0-18933", startTime: 0, endTime: 18.933, method: "yoloe+botsort",
      status: "lost", samples: lost, provenance: "engine", createdAt: 1,
    });
    // …then the sot repair lands over the near-identical range [0, 19.021].
    const okSamples = Array.from({ length: 20 }, (_, i) => ({
      t: i * 0.95, x: 40, y: 40, w: 30, h: 60, confidence: 0.9, visible: true,
    }));
    await upsertSegment("trk", {
      id: "seg-0-19021", startTime: 0, endTime: 19.021, method: "sot",
      status: "ok", samples: okSamples, provenance: "agent", createdAt: 2,
    });
    const t = await readTrack("p", "trk");
    const overlapping = (t!.segments ?? []).filter(
      (s) => s.startTime < 19.021 && s.endTime > 0,
    );
    // The superseded engine segment is GONE from the table…
    expect(overlapping.map((s) => s.id)).toEqual(["seg-0-19021"]);
    // …and the derived stitch is the repair, with no invisible resurrections.
    expect(t!.samples.filter((s) => s.visible)).toHaveLength(okSamples.length);
    expect(t!.samples.every((s) => s.visible)).toBe(true);
  });

  it("replaces only the targeted segment, leaving siblings intact, no dupes", async () => {
    await upsertSegment("trk", { id: "s-5-6", startTime: 5, endTime: 6, method: "skip", status: "skipped", samples: [], reason: "back to camera" });
    const t = await readTrack("p", "trk");
    const ids = (t!.segments ?? []).map((s) => s.id).sort();
    expect(ids).toContain("s-5-6");
    expect(ids).toContain("seg-legacy");                 // original full-range segment untouched
    expect(t!.segments!.find((s) => s.id === "s-5-6")!.status).toBe("skipped");
    await upsertSegment("trk", { id: "s-5-6", startTime: 5, endTime: 6, method: "skip", status: "skipped", samples: [], reason: "v2" });
    const t2 = await readTrack("p", "trk");
    expect(t2!.segments!.filter((s) => s.id === "s-5-6")).toHaveLength(1);   // replace, not append
    expect(t2!.segments!.find((s) => s.id === "s-5-6")!.reason).toBe("v2");
  });
});
