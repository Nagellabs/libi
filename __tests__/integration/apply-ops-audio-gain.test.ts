/* eslint-disable @typescript-eslint/no-explicit-any -- decoded tool results are loosely typed JSON */
/**
 * B3 inside libi.apply_ops: one gain and one volume envelope fanned out to every piece of a folder in ONE call
 * (the Dreams session re-uploaded a baked bed to six pieces three times). Real MCP client, real handlers,
 * in-memory DB, temp storage; the same harness as apply-ops-mcp.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { pieces } from "@/lib/db/schema/sqlite";
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
import { loadManifest, saveManifest } from "@/lib/composition/persistence";

const PIECES = ["piece-a", "piece-b", "piece-c"] as const;

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
    close: async () => { await client.close(); await server.close(); },
  };
}

describe("libi.apply_ops carries gain and volume keyframes", () => {
  let h: Awaited<ReturnType<typeof connect>>;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    for (const id of PIECES) {
      seedPiece(testDb, { id, name: id });
      await saveManifest(id, {
        width: 1080, height: 1920, fps: 30, overlays: [],
        audioClips: [{ id: "bed", kind: "standalone", fileId: "song", startTime: 0, duration: 20, trimStart: 0, volume: 1, enabled: true }] as never,
      });
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

  it("sets +4 dB and a 12 dB dip on the bed of every piece in one call, and says so in words", async () => {
    const res = await h.call("libi.apply_ops", {
      targets: { pieceIds: [...PIECES] },
      ops: [
        { op: "audio_clip", action: "update", clipId: "bed", gainDb: 4 },
        { op: "add_keyframe", clipId: "bed", time: 5, properties: { volumeDb: 0 } },
        { op: "add_keyframe", clipId: "bed", time: 7, properties: { volumeDb: -12 }, easing: "ease-in-out" },
        { op: "add_keyframe", clipId: "bed", time: 12, properties: { volumeDb: -12 } },
        { op: "add_keyframe", clipId: "bed", time: 14, properties: { volumeDb: 0 } },
      ],
    });
    expect(res.body.success, res.text).toBe(true);
    for (const id of PIECES) {
      const bed = (await loadManifest(id)).audioClips![0];
      expect(bed.gainDb).toBe(4);
      expect(bed.volumeKeyframes!.keyframes).toEqual([
        { t: 5, value: 0 },
        { t: 7, value: -12, easing: "ease-in-out" },
        { t: 12, value: -12 },
        { t: 14, value: 0 },
      ]);
    }
    const first = (res.body.data.pieces as { changes: string[] | string }[])[0].changes as string[];
    expect(first.join("\n")).toMatch(/audio clip bed: gain \+4 dB, envelope 4 keys/);
  });

  it("refuses an envelope key past the clip for the piece, leaving that piece untouched", async () => {
    const res = await h.call("libi.apply_ops", {
      targets: { pieceId: "piece-a" },
      ops: [{ op: "add_keyframe", clipId: "bed", time: 99, properties: { volumeDb: -6 } }],
    });
    const report = (res.body.data.pieces as { status: string }[])[0];
    expect(report.status).not.toBe("applied");
    expect((await loadManifest("piece-a")).audioClips![0].volumeKeyframes).toBeUndefined();
  });
});
