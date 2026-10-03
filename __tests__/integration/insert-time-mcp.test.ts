/* eslint-disable @typescript-eslint/no-explicit-any -- decoded tool results are loosely typed JSON */
/**
 * B2: ripple insert through a real MCP client, alone and inside libi.apply_ops ("make the intro 3 s longer in
 * all six" is ONE call; here three). Same harness as apply-ops-mcp.test.ts: real handlers, in-memory DB,
 * temp storage.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { files, pieces } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
let tempDir: string;
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(tempDir) }));
vi.mock("@/lib/navigation-events", () => ({ navigationEmitter: { emit: vi.fn() } }));
vi.mock("@/lib/libi-home", async (orig) => ({
  ...(await orig<typeof import("@/lib/libi-home")>()),
  getCurrentPort: () => 4555,
}));

import { createLibiMcpServer } from "@/mcp/server";
import { loadManifest, saveManifest, type CompositionManifest } from "@/lib/composition/persistence";

const PIECES = ["piece-a", "piece-b", "piece-c"] as const;
const RECT = { x: 0, y: 0, width: 1080, height: 1920 };

/** The benchmark shape: intro video 0-5 with room in its 8 s source, narration at 5.3, a caption, an end card. */
function benchmarkManifest(pid: string): CompositionManifest {
  return {
    width: 1080,
    height: 1920,
    fps: 30,
    overlays: [
      { id: "code-bg", kind: "code", startTime: 0, duration: 20, rect: RECT, z: 0, opacity: 1, drawFunction: "", displayName: "bg" },
      { id: "vid-intro", kind: "video", fileId: `intro-${pid}`, startTime: 0, duration: 5, rect: RECT, z: 1, opacity: 1, trim: { start: 0, end: 5 } },
      {
        id: "text-cap", kind: "text", startTime: 5.3, duration: 6, rect: { x: 90, y: 1500, width: 900, height: 120 }, z: 2, opacity: 1,
        content: "hello", font: "48px Inter", color: "#fff", align: "center",
        caption: { groupId: "g", useTrackStyle: true, words: [{ text: "hello", start: 0.1, end: 0.5 }] },
      },
      { id: "code-end", kind: "code", startTime: 15, duration: 5, rect: RECT, z: 3, opacity: 1, drawFunction: "", displayName: "end card" },
    ] as never,
    audioClips: [
      { id: "ac-intro", kind: "inline", fileId: `intro-${pid}`, linkedOverlayId: "vid-intro", startTime: 0, duration: 5, trimStart: 0, volume: 1, enabled: true },
      { id: "ac-narr", kind: "standalone", fileId: `narr-${pid}`, startTime: 5.3, duration: 6, trimStart: 0, volume: 1, enabled: true },
      {
        id: "ac-music", kind: "standalone", fileId: `song-${pid}`, startTime: 0, duration: 20, trimStart: 0, volume: 0.4, enabled: true,
        duck: { sidechainClipIds: ["ac-narr"], thresholdDb: -30, ratio: 4, attackMs: 10, releaseMs: 200, reductionDb: 10 },
      },
    ] as never,
  };
}

function file(pieceId: string, id: string, type: "video" | "audio", duration: number) {
  testDb.insert(files).values({
    id, pieceId, filename: `${id}.mp4`, name: id, description: "", type, storagePath: `${pieceId}/${id}`, size: 1, mediaDuration: duration,
  }).run();
}

async function connect() {
  const server = createLibiMcpServer({ surface: "in-app" });
  const client = new Client({ name: "t", version: "0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return {
    call: async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as { text: string }[])[0].text;
      return { isError: !!res.isError, body: JSON.parse(text) as Record<string, any>, text };
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("libi.clip insert_time over MCP", () => {
  let h: Awaited<ReturnType<typeof connect>>;
  const realFetch = globalThis.fetch;
  /** What each piece loads as right after seeding (load normalises a manifest, e.g. a duck's fields). */
  let seeded: Record<string, CompositionManifest>;

  beforeEach(async () => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seeded = {};
    for (const id of PIECES) {
      seedPiece(testDb, { id, name: id });
      file(id, `intro-${id}`, "video", 8);
      file(id, `narr-${id}`, "audio", 6);
      file(id, `song-${id}`, "audio", 90);
      await saveManifest(id, benchmarkManifest(id));
      seeded[id] = await loadManifest(id);
      testDb.update(pieces).set({ hasDraft: false }).where(eq(pieces.id, id)).run();
    }
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as never;
    h = await connect();
  });
  afterEach(async () => {
    await h.close();
    globalThis.fetch = realFetch;
    cleanupTempDir(tempDir);
  });

  const ov = (m: CompositionManifest, id: string) => m.overlays!.find((o) => o.id === id) as any;
  const clip = (m: CompositionManifest, id: string) => m.audioClips!.find((c) => c.id === id)!;

  it("one call: the intro runs 3 s longer, everything after it moves, the full-length layers stretch, and the result says so", async () => {
    const res = await h.call("libi.clip", { action: "insert_time", pieceId: "piece-a", at: 5, seconds: 3, extendTarget: "vid-intro" });
    expect(res.body.success, res.text).toBe(true);
    expect(res.body.data).toMatchObject({
      at: 5,
      seconds: 3,
      pieceDuration: { before: 20, after: 23 },
      extended: [{ id: "vid-intro", duration: [5, 8], trim: [[0, 5], [0, 8]] }],
    });
    expect([...res.body.data.shifted].sort()).toEqual(["ac-narr", "code-end", "text-cap"]);
    expect([...res.body.data.stretched].sort()).toEqual(["ac-music", "code-bg"]);
    expect(res.text.length).toBeLessThan(700);

    const m = await loadManifest("piece-a");
    expect(ov(m, "vid-intro")).toMatchObject({ duration: 8, trim: { start: 0, end: 8 } });
    expect(clip(m, "ac-intro")).toMatchObject({ startTime: 0, duration: 8 });
    expect(ov(m, "text-cap").startTime).toBeCloseTo(8.3);
    expect(ov(m, "text-cap").caption.words).toEqual([{ text: "hello", start: 0.1, end: 0.5 }]);
    expect(clip(m, "ac-narr").startTime).toBeCloseTo(8.3);
    expect(ov(m, "code-end").startTime).toBe(18);
    expect(ov(m, "code-bg").duration).toBe(23);
    expect(clip(m, "ac-music").duration).toBe(23);
    expect((clip(m, "ac-music") as any).duck.sidechainClipIds).toEqual(["ac-narr"]);
  });

  it("refuses with how much footage is left when the source has no room, and writes nothing", async () => {
    const res = await h.call("libi.clip", { action: "insert_time", pieceId: "piece-a", at: 5, seconds: 4, extendTarget: "vid-intro" });
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/only 3 s of footage is left/);
    expect(res.body.data).toMatchObject({ code: "no_source_room" });
    expect(await loadManifest("piece-a")).toEqual(seeded["piece-a"]);
  });

  it("accepts the stretch modes as a bare word or a one-word list, and refuses a mixed list", async () => {
    const none = await h.call("libi.clip", { action: "insert_time", pieceId: "piece-a", at: 5, seconds: 3, stretch: "none" });
    expect(none.body.success, none.text).toBe(true);
    expect(none.body.data.stretched).toEqual([]);
    expect(none.body.data.leftSpanning.sort()).toEqual(["ac-music", "code-bg"]);
    expect(none.body.data.note).toMatch(/pass `stretch` with their ids/);
    const mixed = await h.call("libi.clip", { action: "insert_time", pieceId: "piece-b", at: 5, seconds: 3, stretch: ["none", "code-bg"] });
    expect(mixed.body.success).toBe(false);
    expect(mixed.body.error).toMatch(/modes of their own/);
  });

  it("says nothing moved when nothing is at or after `at`", async () => {
    const res = await h.call("libi.clip", { action: "insert_time", pieceId: "piece-a", at: 60, seconds: 3 });
    expect(res.body.success).toBe(true);
    expect(res.body.data.note).toMatch(/piece is unchanged/);
  });

  it("is ONE apply_ops op over three pieces, each rolled out with its own source check", async () => {
    // piece-c's intro file is only 6 s long: no room for 3 s there.
    testDb.update(files).set({ mediaDuration: 6 }).where(eq(files.id, "intro-piece-c")).run();
    const res = await h.call("libi.apply_ops", {
      targets: { pieceIds: [...PIECES] },
      ops: [{ op: "clip", action: "insert_time", at: 5, seconds: 3, extendTarget: "vid-intro" }],
    });
    const reports = res.body.data.pieces as { pieceId: string; status: string; changes: string[] | string; error?: string }[];
    expect(reports.map((r) => [r.pieceId, r.status])).toEqual([["piece-a", "applied"], ["piece-b", "applied"], ["piece-c", "rolled_back"]]);
    for (const id of ["piece-a", "piece-b"]) {
      const m = await loadManifest(id);
      expect(ov(m, "vid-intro").duration).toBe(8);
      expect(ov(m, "code-end").startTime).toBe(18);
    }
    expect(await loadManifest("piece-c")).toEqual(seeded["piece-c"]);
    const lines = (reports[0].changes as string[]).join("\n");
    expect(lines).toContain("overlay vid-intro: duration 5→8, trim 0–5→0–8");
    expect(lines).toContain("overlay code-end: start 15→18");
    expect(reports[1].changes).toBe("same as piece-a");
  });
});
