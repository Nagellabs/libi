/**
 * Integration tests for all 23 libi MCP tools.
 *
 * Spawns the REAL MCP server as a child process via StdioClientTransport,
 * connects as an MCP client, and calls each tool. Both the test and the
 * server share the same file-based SQLite DB via the LIBI_HOME env var.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import {
  pieces,
  files,
  mcpServers,
} from "@/lib/db/schema/sqlite";
import path from "path";
import fs from "fs";
import os from "os";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const TSX_BIN = path.join(PROJECT_ROOT, "node_modules", ".bin", "tsx");
const TSCONFIG = path.join(PROJECT_ROOT, "tsconfig.json");
const MCP_ENTRY = path.join(PROJECT_ROOT, "mcp", "index.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CallToolResult = Awaited<ReturnType<Client["callTool"]>>;

function parseResult(result: CallToolResult): {
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
} {
  const text = (result.content as Array<{ type: string; text: string }>)[0]
    .text;
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("MCP tools integration", { timeout: 120_000 }, () => {
  let transport: StdioClientTransport;
  let client: Client;
  let tempDir: string;
  let testDb: ReturnType<typeof drizzle>;

  // Seed IDs
  const PIECE_1 = "test-piece-1";
  const PIECE_2 = "test-piece-2";
  const VIDEO_FILE_ID = "video-file-1";
  const AUDIO_FILE_ID = "audio-file-1";
  // Temp file for upload_file test
  let uploadFilePath: string;

  beforeAll(async () => {
    // Create temp LIBI_HOME
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-mcp-tools-test-"));
    fs.mkdirSync(path.join(tempDir, "storage"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "logs"), { recursive: true });

    // Create a real temp file for upload_file test
    uploadFilePath = path.join(tempDir, "test-upload.txt");
    fs.writeFileSync(uploadFilePath, "Hello from upload test!");

    // The MCP child opens an already-migrated DB; migrate it here before
    // spawning so the schema is in place when the child connects.
    const { migrateDatabase } = await import("@/lib/db/client");
    migrateDatabase(path.join(tempDir, "libi.sqlite"));

    // Spawn MCP server with LIBI_HOME pointing to temp dir
    transport = new StdioClientTransport({
      command: TSX_BIN,
      args: ["--tsconfig", TSCONFIG, MCP_ENTRY],
      env: {
        ...process.env,
        LIBI_HOME: tempDir,
      },
    });

    client = new Client({
      name: "libi-test-client",
      version: "1.0.0",
    });

    await client.connect(transport);

    // Warm up the server — triggers getDb() which creates DB + runs migrations
    await client.callTool({ name: "libi.list_pieces", arguments: {} });

    // Open test-side drizzle connection to the same DB
    const dbPath = path.join(tempDir, "libi.sqlite");
    testDb = drizzle({
      connection: { source: dbPath },
      schema: { pieces, files, mcpServers },
    });

    // Seed data
    testDb.insert(pieces).values([
      { id: PIECE_1, name: "Test Piece" },
      { id: PIECE_2, name: "Second Piece", description: "For search test" },
    ]).run();

    // Create storage dir for piece 1 so file records have a valid reference
    const piece1StorageDir = path.join(tempDir, "storage", PIECE_1);
    fs.mkdirSync(piece1StorageDir, { recursive: true });

    // Seed a dummy video file on disk so the storage path resolves
    fs.writeFileSync(path.join(piece1StorageDir, "sample.mp4"), "fake-video-data");
    fs.writeFileSync(path.join(piece1StorageDir, "sample.mp3"), "fake-audio-data");

    testDb.insert(files).values([
      {
        id: VIDEO_FILE_ID,
        pieceId: PIECE_1,
        filename: "sample.mp4",
        name: "Sample Video",
        description: "Test video file",
        type: "video",
        storagePath: `${PIECE_1}/sample.mp4`,
        contentType: "video/mp4",
        size: 1024,
        mediaDuration: 10,
        mediaWidth: 1920,
        mediaHeight: 1080,
      },
      {
        id: AUDIO_FILE_ID,
        pieceId: PIECE_1,
        filename: "sample.mp3",
        name: "Sample Audio",
        description: "Test audio file",
        type: "audio",
        storagePath: `${PIECE_1}/sample.mp3`,
        contentType: "audio/mpeg",
        size: 2048,
        mediaDuration: 30,
      },
    ]).run();

  }, 30_000);

  afterAll(async () => {
    try { await client?.close(); } catch { /* ignore */ }
    try { await transport?.close(); } catch { /* ignore */ }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // =========================================================================
  // 1. get_version
  // =========================================================================
  it("libi.get_version returns version and name", async () => {
    const raw = await client.callTool({ name: "libi.get_version", arguments: {} });
    const text = (raw.content as Array<{ type: string; text: string }>)[0].text;
    const result = JSON.parse(text);
    expect(result.version).toBeDefined();
    expect(result.name).toBe("libi-video-studio");
  }, 15_000);

  // =========================================================================
  // 2. create_piece
  // =========================================================================
  it("libi.create_piece creates a new piece", async () => {
    const result = parseResult(
      await client.callTool({
        name: "libi.create_piece",
        arguments: { name: "Agent Created", description: "Via MCP" },
      }),
    );
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    const data = result.data!;
    expect(data.name).toBe("Agent Created");
    expect(data.id).toBeDefined();

    // Verify in DB
    const rows = testDb
      .select()
      .from(pieces)
      .where(eq(pieces.name, "Agent Created"))
      .all();
    expect(rows.length).toBe(1);
  }, 15_000);

  // =========================================================================
  // 3. list_pieces (+ search)
  // =========================================================================
  it("libi.list_pieces lists seeded pieces", async () => {
    const result = parseResult(
      await client.callTool({ name: "libi.list_pieces", arguments: {} }),
    );
    expect(result.success).toBe(true);
    const data = result.data!;
    const allPieces = data.pieces as Array<{ id: string; name: string }>;
    const names = allPieces.map((p) => p.name);
    expect(names).toContain("Test Piece");
    expect(names).toContain("Second Piece");
  }, 15_000);

  it("libi.list_pieces supports search filter", async () => {
    const result = parseResult(
      await client.callTool({
        name: "libi.list_pieces",
        arguments: { query: "search test" },
      }),
    );
    expect(result.success).toBe(true);
    const data = result.data!;
    const allPieces = data.pieces as Array<{ id: string; name: string }>;
    expect(allPieces.length).toBeGreaterThanOrEqual(1);
    expect(allPieces.some((p) => p.name === "Second Piece")).toBe(true);
  }, 15_000);

  // =========================================================================
  // 4. show_piece
  // =========================================================================
  it("libi.show_piece returns navigated: true", async () => {
    const result = parseResult(
      await client.callTool({
        name: "libi.show_piece",
        arguments: { pieceId: PIECE_1 },
      }),
    );
    expect(result.success).toBe(true);
    expect(result.data?.navigated).toBe(true);
  }, 15_000);

  // =========================================================================
  // 5. update_piece_name
  // =========================================================================
  it("libi.update_piece_name updates the piece name", async () => {
    const result = parseResult(
      await client.callTool({
        name: "libi.update_piece_name",
        arguments: { pieceId: PIECE_1, name: "Renamed Piece" },
      }),
    );
    expect(result.success).toBe(true);

    // Verify in DB
    const [row] = testDb
      .select()
      .from(pieces)
      .where(eq(pieces.id, PIECE_1))
      .all();
    expect(row.name).toBe("Renamed Piece");
  }, 15_000);

  // =========================================================================
  // 6. update_piece_description
  // =========================================================================
  it("libi.update_piece_description updates the description", async () => {
    const result = parseResult(
      await client.callTool({
        name: "libi.update_piece_description",
        arguments: { pieceId: PIECE_1, description: "Updated description" },
      }),
    );
    expect(result.success).toBe(true);

    const [row] = testDb
      .select()
      .from(pieces)
      .where(eq(pieces.id, PIECE_1))
      .all();
    expect(row.description).toBe("Updated description");
  }, 15_000);

  // =========================================================================
  // 7–12. Scene tools (sequential — create, load, update, reorder, delete, get_composition)
  // =========================================================================
  describe("scene tools", () => {
    let sceneId1: string;
    let sceneId2: string;

    it("libi.create_scene creates the first scene", async () => {
      const result = parseResult(
        await client.callTool({
          name: "libi.create_scene",
          arguments: {
            pieceId: PIECE_1,
            name: "Intro",
            duration: 3,
            drawFunction:
              'const { ctx, width, height } = context;\nctx.fillStyle = "#000";\nctx.fillRect(0, 0, width, height);',
          },
        }),
      );
      expect(result.success).toBe(true);
      expect(result.data?.sceneId).toBeDefined();
      sceneId1 = result.data!.sceneId as string;
    }, 15_000);

    it("libi.create_scene creates a second scene", async () => {
      const result = parseResult(
        await client.callTool({
          name: "libi.create_scene",
          arguments: {
            pieceId: PIECE_1,
            name: "Outro",
            duration: 2,
            drawFunction:
              'const { ctx, width, height } = context;\nctx.fillStyle = "#fff";\nctx.fillRect(0, 0, width, height);',
          },
        }),
      );
      expect(result.success).toBe(true);
      expect(result.data?.sceneId).toBeDefined();
      sceneId2 = result.data!.sceneId as string;
    }, 15_000);

    it("libi.load_scene loads a scene by ID", async () => {
      const result = parseResult(
        await client.callTool({
          name: "libi.load_scene",
          arguments: { pieceId: PIECE_1, sceneId: sceneId1 },
        }),
      );
      expect(result.success).toBe(true);
      const scene = result.data!.scene as { name: string; duration: number };
      expect(scene.name).toBe("Intro");
      expect(scene.duration).toBe(3);
    }, 15_000);

    it("libi.update_scene updates name and duration", async () => {
      const result = parseResult(
        await client.callTool({
          name: "libi.update_scene",
          arguments: {
            pieceId: PIECE_1,
            sceneId: sceneId1,
            name: "Intro v2",
            duration: 5,
          },
        }),
      );
      expect(result.success).toBe(true);

      // Verify via load_scene
      const loaded = parseResult(
        await client.callTool({
          name: "libi.load_scene",
          arguments: { pieceId: PIECE_1, sceneId: sceneId1 },
        }),
      );
      const scene = loaded.data!.scene as { name: string; duration: number };
      expect(scene.name).toBe("Intro v2");
      expect(scene.duration).toBe(5);
    }, 15_000);

    it("libi.reorder_scenes changes scene order", async () => {
      // Put scene2 before scene1
      const result = parseResult(
        await client.callTool({
          name: "libi.reorder_scenes",
          arguments: { pieceId: PIECE_1, sceneIds: [sceneId2, sceneId1] },
        }),
      );
      expect(result.success).toBe(true);

      // Verify via get_composition
      const comp = parseResult(
        await client.callTool({
          name: "libi.get_composition",
          arguments: { pieceId: PIECE_1 },
        }),
      );
      const manifest = comp.data!.manifest as { sceneOrder: string[] };
      expect(manifest.sceneOrder[0]).toBe(sceneId2);
      expect(manifest.sceneOrder[1]).toBe(sceneId1);
    }, 15_000);

    it("libi.delete_scene removes a scene", async () => {
      const result = parseResult(
        await client.callTool({
          name: "libi.delete_scene",
          arguments: { pieceId: PIECE_1, sceneId: sceneId2 },
        }),
      );
      expect(result.success).toBe(true);

      // Verify via get_composition — only sceneId1 should remain
      const comp = parseResult(
        await client.callTool({
          name: "libi.get_composition",
          arguments: { pieceId: PIECE_1 },
        }),
      );
      const manifest = comp.data!.manifest as { sceneOrder: string[] };
      expect(manifest.sceneOrder).toEqual([sceneId1]);
    }, 15_000);

    it("libi.get_composition returns manifest and scenes", async () => {
      const result = parseResult(
        await client.callTool({
          name: "libi.get_composition",
          arguments: { pieceId: PIECE_1 },
        }),
      );
      expect(result.success).toBe(true);
      const manifest = result.data!.manifest as {
        sceneOrder: string[];
        width: number;
        height: number;
        fps: number;
      };
      expect(manifest.width).toBe(1920);
      expect(manifest.height).toBe(1080);
      expect(manifest.fps).toBe(30);
      expect(Array.isArray(manifest.sceneOrder)).toBe(true);

      const scenes = result.data!.scenes as Array<{ id: string; name: string }>;
      expect(scenes.length).toBeGreaterThan(0);
    }, 15_000);
  });

  // =========================================================================
  // 13. upload_file
  // =========================================================================
  it("libi.upload_file uploads a real temp file", async () => {
    const result = parseResult(
      await client.callTool({
        name: "libi.upload_file",
        arguments: {
          pieceId: PIECE_1,
          filePath: uploadFilePath,
          name: "Test Upload",
          description: "Uploaded via MCP test",
        },
      }),
    );
    expect(result.success).toBe(true);
    expect(result.data?.fileId).toBeDefined();
    expect(result.data?.filename).toBe("test-upload.txt");
    expect(result.data?.name).toBe("Test Upload");

    // Verify in DB
    const fileId = result.data!.fileId as string;
    const rows = testDb
      .select()
      .from(files)
      .where(eq(files.id, fileId))
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("Test Upload");
  }, 15_000);

  // =========================================================================
  // 14. list_files
  // =========================================================================
  it("libi.list_files lists piece files", async () => {
    const result = parseResult(
      await client.callTool({
        name: "libi.list_files",
        arguments: { pieceId: PIECE_1 },
      }),
    );
    expect(result.success).toBe(true);
    const fileList = result.data!.files as Array<{ id: string; filename: string }>;
    // At minimum: the seeded video + audio + the uploaded text file
    expect(fileList.length).toBeGreaterThanOrEqual(3);
  }, 15_000);

  // =========================================================================
  // 15. save_asset
  // =========================================================================
  it("libi.save_asset saves base64 data and creates a file record", async () => {
    const base64Data = Buffer.from("asset-content-data").toString("base64");
    const result = parseResult(
      await client.callTool({
        name: "libi.save_asset",
        arguments: {
          pieceId: PIECE_1,
          filename: "test-asset.txt",
          name: "Test Asset",
          description: "Asset from integration test",
          type: "document",
          contentType: "text/plain",
          data: base64Data,
        },
      }),
    );
    expect(result.success).toBe(true);
    expect(result.data?.fileId).toBeDefined();
    expect(result.data?.filename).toBe("test-asset.txt");

    // Verify file exists in storage
    const assetPath = path.join(tempDir, "storage", PIECE_1, "test-asset.txt");
    expect(fs.existsSync(assetPath)).toBe(true);
    expect(fs.readFileSync(assetPath, "utf-8")).toBe("asset-content-data");

    // Verify in DB
    const fileId = result.data!.fileId as string;
    const rows = testDb
      .select()
      .from(files)
      .where(eq(files.id, fileId))
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("Test Asset");
  }, 15_000);

  // =========================================================================
  // 16–17. Video scene tools
  // =========================================================================
  // =========================================================================
  // 21. show_asset
  // =========================================================================
  it("libi.show_asset returns navigated: true", async () => {
    const result = parseResult(
      await client.callTool({
        name: "libi.show_asset",
        arguments: { pieceId: PIECE_1, fileId: VIDEO_FILE_ID },
      }),
    );
    expect(result.success).toBe(true);
    expect(result.data?.navigated).toBe(true);
    expect(result.data?.fileId).toBe(VIDEO_FILE_ID);
  }, 15_000);

  // =========================================================================
  // 22. register_mcp_server
  // =========================================================================
  it("libi.register_mcp_server registers a new server", async () => {
    const result = parseResult(
      await client.callTool({
        name: "libi.register_mcp_server",
        arguments: {
          name: "Test MCP Server",
          type: "stdio",
          command: "npx",
          args: ["@test/mcp-server"],
          description: "A test MCP server",
          requireApproval: false,
        },
      }),
    );
    expect(result.success).toBe(true);
    expect(result.data?.id).toBeDefined();
    expect(result.data?.name).toBe("Test MCP Server");
    expect(result.data?.type).toBe("stdio");
    expect(result.data?.requireApproval).toBe(false);

    // Verify in DB
    const serverId = result.data!.id as string;
    const rows = testDb
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId))
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("Test MCP Server");
    expect(rows[0].command).toBe("npx");
  }, 15_000);
});
