/* eslint-disable @typescript-eslint/no-explicit-any -- decoded tool results are loosely typed JSON */
/**
 * agent-speed B5 through a REAL MCP client: ONE `libi.upload_file` into three pieces, then ONE `libi.apply_ops`
 * that adds the clip in all three using the ids the upload returned (its `perPiece` result, verbatim).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { files, folders, pieces } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { parseAudioRights } from "@/lib/audio-rights/types";
import { hasFfmpeg } from "@/__tests__/helpers/media";
import * as fs from "fs";
import * as path from "path";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));
vi.mock("@/lib/navigation-events", () => ({ navigationEmitter: { emit: vi.fn() } }));
vi.mock("@/lib/libi-home", async (orig) => ({
  ...(await orig<typeof import("@/lib/libi-home")>()),
  getCurrentPort: () => 4555,
}));

import { createLibiMcpServer } from "@/mcp/server";
import { loadManifest, saveManifest } from "@/lib/composition/persistence";

const FOLDER = "folder-1";
const PIECES = ["piece-a", "piece-b", "piece-c"] as const;

/** A 2 s, 8 kHz mono 16-bit PCM WAV: a real file ffprobe can read. */
function wav(seconds: number): Buffer {
  const rate = 8000;
  const data = Buffer.alloc(rate * seconds * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
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
    list: async () => (await client.listTools()).tools,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("libi.upload_file into several pieces, then libi.apply_ops with its perPiece", () => {
  let h: Awaited<ReturnType<typeof connect>>;
  let songPath: string;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    testDb.insert(folders).values({ id: FOLDER, name: "Dreams" }).run();
    for (const id of PIECES) {
      seedPiece(testDb, { id, name: id });
      testDb.update(pieces).set({ folderId: FOLDER }).where(eq(pieces.id, id)).run();
      await saveManifest(id, {
        width: 1080, height: 1920, fps: 30, overlays: [],
        audioClips: [{ id: "vo-1", kind: "standalone", fileId: "vo", startTime: 0, duration: 2, trimStart: 0, volume: 1, enabled: true }] as never,
      });
      testDb.update(pieces).set({ hasDraft: false }).where(eq(pieces.id, id)).run();
    }
    songPath = path.join(tempDir, "dreams.wav");
    fs.writeFileSync(songPath, wav(2));
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as never;
    h = await connect();
  });

  afterEach(async () => {
    await h.close();
    globalThis.fetch = realFetch;
    cleanupTempDir(tempDir);
  });

  it("one upload for a folder, one apply_ops that adds the clip in all three with the returned ids", async () => {
    const up = await h.call("libi.upload_file", { filePath: songPath, pieceFolderId: FOLDER });
    expect(up.body.success).toBe(true);
    const { files: stored, perPiece } = up.body.data as { files: { pieceId: string; fileId: string }[]; perPiece: Record<string, { fileId: string }> };
    expect(stored.map((f) => f.pieceId).sort()).toEqual([...PIECES]);
    // Each piece has its own row, its own bytes on disk, the user's-own rights and the probed length.
    for (const f of stored) {
      const row = testDb.select().from(files).where(eq(files.id, f.fileId)).get()!;
      expect(row.pieceId).toBe(f.pieceId);
      expect(fs.existsSync(path.join(tempDir, f.pieceId, "dreams.wav"))).toBe(true);
      // The probed length needs ffprobe; the publish job runs this suite without ffmpeg (hasFfmpeg skips there,
      // and throws in the gates, where LIBI_REQUIRE_FFMPEG=1 says it must be present).
      if (hasFfmpeg()) expect(row.mediaDuration).toBeCloseTo(2, 1);
      expect(parseAudioRights(row.audioRights)).toMatchObject({ class: "owned" });
    }

    // The upload's perPiece goes into apply_ops as it came.
    const res = await h.call("libi.apply_ops", {
      targets: { folderId: FOLDER },
      ops: [{ op: "audio_add_clip", as: "music", startTime: 0, duration: 2, volume: 0.5, perPiece }],
    });
    expect(res.body.success).toBe(true);
    expect((res.body.data.pieces as { status: string }[]).map((p) => p.status)).toEqual(["applied", "applied", "applied"]);
    for (const pid of PIECES) {
      const m = await loadManifest(pid);
      const music = m.audioClips!.find((c) => c.id !== "vo-1")!;
      expect(music.fileId).toBe(perPiece[pid].fileId);
    }
  });

  it("advertises the targets and refuses mixing them through the real server", async () => {
    const tool = (await h.list()).find((t) => t.name === "libi.upload_file")!;
    const props = tool.inputSchema.properties as Record<string, any>;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["pieceId", "pieceIds", "pieceFolderId", "recursive", "filePath"]));
    expect(tool.inputSchema.required ?? []).toEqual(["filePath"]);
    const mixed = await h.call("libi.upload_file", { filePath: songPath, pieceId: "piece-a", pieceIds: ["piece-b"] });
    expect(mixed.body.success).toBe(false);
    expect(testDb.select().from(files).all()).toHaveLength(0);
    const single = await h.call("libi.upload_file", { filePath: songPath, pieceId: "piece-a" });
    expect(single.body.success).toBe(true);
    expect(single.body.data.fileId).toEqual(expect.any(String));
    expect(single.body.data.files).toBeUndefined();
  });
});
