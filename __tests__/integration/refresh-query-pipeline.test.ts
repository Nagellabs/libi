/**
 * Integration: MCP server → notify → HTTP POST body contract.
 *
 * Exercises the real MCP server via the SDK's InMemoryTransport, mocks DB
 * and storage (like tool-pipeline.test.ts), and taps `fetch` to capture
 * what notify.refreshQuery would send to `/api/notify`. Verifies that each
 * composition-mutating tool fires the push event with the correct
 * {queryKey, pieceId, sceneId} shape — which is the tool-side half of
 * the fix for "timeline doesn't update until page reload".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import {
  createTempStorageDir,
  cleanupTempDir,
} from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";

// -- Mock DB to use in-memory SQLite --
let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({
  getDb: () => testDb,
}));

// -- Mock storage with a temp dir --
let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

// -- Stub the port file so notify builds a URL --
vi.mock("@/lib/libi-home", async () => {
  const actual = await vi.importActual<typeof import("@/lib/libi-home")>(
    "@/lib/libi-home",
  );
  return {
    ...actual,
    getCurrentPort: () => 3456,
  };
});

// Import after mocks so everything downstream sees them.
import { createLibiMcpServer } from "@/mcp/server";

const PIECE_ID = "pipeline-piece-1";
const VALID_DRAW = `const { ctx, width, height } = context;
ctx.fillStyle = '#000';
ctx.fillRect(0, 0, width, height);`;

interface CapturedNotify {
  url: string;
  body: Record<string, unknown>;
}

describe("MCP tool → notify.refreshQuery pipeline", () => {
  let client: Client;
  let captured: CapturedNotify[];
  let origFetch: typeof fetch;

  beforeEach(async () => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE_ID, name: "Pipeline Piece" });

    captured = [];
    origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/notify") && init?.body) {
        captured.push({
          url,
          body: JSON.parse(init.body as string) as Record<string, unknown>,
        });
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const server = createLibiMcpServer();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientT);
  });

  afterEach(async () => {
    globalThis.fetch = origFetch;
    try { await client.close(); } catch { /* ignore */ }
    cleanupTempDir(tempDir);
  });

  async function waitForNotify(ms = 200): Promise<void> {
    // notify.refreshQuery is fire-and-forget; give the event loop a tick.
    await new Promise((r) => setTimeout(r, ms));
  }

  async function callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const r = await client.callTool({ name, arguments: args });
    const content = r.content as Array<{ type: string; text: string }>;
    return JSON.parse(content[0].text) as Record<string, unknown>;
  }

  it("libi.create_scene fires composition refresh with the new sceneId", async () => {
    const r = await callTool("libi.create_scene", {
      pieceId: PIECE_ID,
      name: "Scene A",
      duration: 3,
      drawFunction: VALID_DRAW,
    });
    expect(r.success).toBe(true);
    const sceneId = (r.data as { sceneId: string }).sceneId;

    await waitForNotify();

    expect(captured).toHaveLength(1);
    expect(captured[0].body).toEqual({
      type: "refresh_query",
      queryKey: "composition",
      pieceId: PIECE_ID,
      sceneId,
    });
  });

  it("libi.update_scene fires composition refresh with the updated sceneId", async () => {
    const created = await callTool("libi.create_scene", {
      pieceId: PIECE_ID,
      name: "Scene A",
      duration: 3,
      drawFunction: VALID_DRAW,
    });
    const sceneId = (created.data as { sceneId: string }).sceneId;
    captured.length = 0;

    const r = await callTool("libi.update_scene", {
      pieceId: PIECE_ID,
      sceneId,
      name: "Scene A (v2)",
    });
    expect(r.success).toBe(true);

    await waitForNotify();

    expect(captured).toHaveLength(1);
    expect(captured[0].body).toEqual({
      type: "refresh_query",
      queryKey: "composition",
      pieceId: PIECE_ID,
      sceneId,
    });
  });

  it("libi.delete_scene fires composition refresh with the deleted sceneId", async () => {
    const created = await callTool("libi.create_scene", {
      pieceId: PIECE_ID,
      name: "Scene X",
      duration: 2,
      drawFunction: VALID_DRAW,
    });
    const sceneId = (created.data as { sceneId: string }).sceneId;
    captured.length = 0;

    const r = await callTool("libi.delete_scene", {
      pieceId: PIECE_ID,
      sceneId,
    });
    expect(r.success).toBe(true);

    await waitForNotify();

    expect(captured).toHaveLength(1);
    expect(captured[0].body.sceneId).toBe(sceneId);
    expect(captured[0].body.queryKey).toBe("composition");
  });

  it("libi.reorder_scenes fires composition refresh with the first reordered id", async () => {
    const a = await callTool("libi.create_scene", {
      pieceId: PIECE_ID,
      name: "A",
      duration: 1,
      drawFunction: VALID_DRAW,
    });
    const b = await callTool("libi.create_scene", {
      pieceId: PIECE_ID,
      name: "B",
      duration: 1,
      drawFunction: VALID_DRAW,
    });
    const aId = (a.data as { sceneId: string }).sceneId;
    const bId = (b.data as { sceneId: string }).sceneId;
    captured.length = 0;

    const r = await callTool("libi.reorder_scenes", {
      pieceId: PIECE_ID,
      sceneIds: [bId, aId],
    });
    expect(r.success).toBe(true);

    await waitForNotify();

    expect(captured).toHaveLength(1);
    expect(captured[0].body).toEqual({
      type: "refresh_query",
      queryKey: "composition",
      pieceId: PIECE_ID,
      sceneId: bId,
    });
  });

  it("libi.update_piece_name fires piece refresh (no sceneId)", async () => {
    const r = await callTool("libi.update_piece_name", {
      pieceId: PIECE_ID,
      name: "Renamed",
    });
    expect(r.success).toBe(true);

    await waitForNotify();

    expect(captured).toHaveLength(1);
    expect(captured[0].body).toEqual({
      type: "refresh_query",
      queryKey: "piece",
      pieceId: PIECE_ID,
    });
  });

  it("failed mutations do NOT fire refresh (eval() rejected by validator)", async () => {
    const r = await callTool("libi.create_scene", {
      pieceId: PIECE_ID,
      name: "Evil",
      duration: 1,
      drawFunction: "eval('nope')",
    });
    expect(r.success).toBe(false);

    await waitForNotify();
    expect(captured).toHaveLength(0);
  });

  it("libi.create_piece fires refresh for pieces + piece", async () => {
    const r = await callTool("libi.create_piece", {
      name: "Brand New",
    });
    expect(r.success).toBe(true);
    const newPieceId = (r.data as { id: string }).id;
    expect(newPieceId).toBeTruthy();

    await waitForNotify();

    expect(captured).toHaveLength(2);
    expect(captured.map((c) => c.body)).toEqual(
      expect.arrayContaining([
        { type: "refresh_query", queryKey: "pieces" },
        { type: "refresh_query", queryKey: "piece", pieceId: newPieceId },
      ]),
    );
  });

  it("libi.upload_file fires refresh for the piece", async () => {
    // Write a small temp file the tool can ingest.
    const fs = await import("fs/promises");
    const path = await import("path");
    const os = await import("os");
    const tmpFile = path.join(os.tmpdir(), `libi-test-upload-${Date.now()}.txt`);
    await fs.writeFile(tmpFile, "hello");

    try {
      const r = await callTool("libi.upload_file", {
        pieceId: PIECE_ID,
        filePath: tmpFile,
      });
      expect(r.success).toBe(true);

      await waitForNotify();

      expect(captured).toHaveLength(1);
      expect(captured[0].body).toEqual({
        type: "refresh_query",
        queryKey: "piece",
        pieceId: PIECE_ID,
      });
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  });

});
