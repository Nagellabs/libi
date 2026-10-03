/* eslint-disable @typescript-eslint/no-explicit-any -- decoded tool results are loosely typed JSON */
/**
 * libi.apply_ops through a REAL MCP client: the same call an agent makes, against the real server, the
 * real tool handlers, a real (temp) piece storage and an in-memory DB. Three pieces share every overlay
 * id (duplicates, as in the Dreams session) and each has its own audio file row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { files, folders, pieces } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

vi.mock("@/lib/navigation-events", () => ({
  navigationEmitter: { emit: vi.fn() },
}));

vi.mock("@/lib/libi-home", async (orig) => ({
  ...(await orig<typeof import("@/lib/libi-home")>()),
  getCurrentPort: () => 4555,
}));

import { createLibiMcpServer } from "@/mcp/server";
import { loadManifest, saveManifest, type CompositionManifest } from "@/lib/composition/persistence";

const FOLDER = "folder-1";
const PIECES = ["piece-a", "piece-b", "piece-c"] as const;

function baseManifest(): CompositionManifest {
  return {
    width: 1080,
    height: 1920,
    fps: 30,
    overlays: [
      { id: "vid-1", kind: "video", fileId: "vidfile", startTime: 0, duration: 8, rect: { x: 0, y: 0, width: 1080, height: 1920 }, z: 0, opacity: 1, trim: { start: 0, end: 8 } },
      { id: "text-1", kind: "text", startTime: 1, duration: 3, rect: { x: 90, y: 1170, width: 900, height: 120 }, z: 1, opacity: 1, content: "Hello", font: "48px Inter", color: "#fff", align: "center" },
    ] as never,
    audioClips: [{ id: "vo-1", kind: "standalone", fileId: "vofile", startTime: 0, duration: 8, trimStart: 0, volume: 1, enabled: true }] as never,
  };
}

function audioFile(pieceId: string, id: string, duration: number) {
  testDb.insert(files).values({
    id, pieceId, filename: `${id}.mp3`, name: id, description: "", type: "audio", storagePath: `${pieceId}/${id}.mp3`, size: 1, mediaDuration: duration,
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
    list: async () => (await client.listTools()).tools,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function onDisk(pieceId: string) {
  return loadManifest(pieceId);
}

const RETIME_AND_DUCK = (musicByPiece: Record<string, string>) => [
  { op: "update_overlay", overlayId: "vid-1", duration: 11, trim: { start: 0, end: 11 } },
  { op: "update_overlay", overlayId: "text-1", rect: { x: 90, y: 1250, width: 900, height: 120 } },
  {
    op: "audio_add_clip",
    as: "music",
    startTime: 0,
    duration: 11,
    volume: 0.4,
    perPiece: Object.fromEntries(Object.entries(musicByPiece).map(([pid, fileId]) => [pid, { fileId }])),
    fileId: "unused-default",
  },
  { op: "audio_duck", action: "enable", clipId: "$music", sidechainClipIds: ["vo-1"], reductionDb: -5 },
];

describe("libi.apply_ops over MCP", () => {
  let h: Awaited<ReturnType<typeof connect>>;
  const realFetch = globalThis.fetch;
  let posted: { path: string; body: any }[];

  beforeEach(async () => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    testDb.insert(folders).values({ id: FOLDER, name: "Dreams" }).run();
    for (const id of PIECES) {
      seedPiece(testDb, { id, name: id });
      testDb.update(pieces).set({ folderId: FOLDER }).where(eq(pieces.id, id)).run();
      audioFile(id, `song-${id}`, 70);
      await saveManifest(id, baseManifest());
      // seeding is not an edit: start every piece with no draft
      testDb.update(pieces).set({ hasDraft: false }).where(eq(pieces.id, id)).run();
    }
    // Notifications and analytics leave the process as HTTP posts; capture them.
    posted = [];
    globalThis.fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posted.push({ path: new URL(String(url)).pathname, body: init?.body ? JSON.parse(init.body) : undefined });
      return new Response("{}", { status: 200 });
    }) as never;
    h = await connect();
  });

  afterEach(async () => {
    await h.close();
    globalThis.fetch = realFetch;
    cleanupTempDir(tempDir);
  });

  it("is a listed tool, with the allow-list in its `op` description and no pieceId on the op", async () => {
    const tool = (await h.list()).find((t) => t.name === "libi.apply_ops")!;
    expect(tool).toBeDefined();
    const props = tool.inputSchema.properties as Record<string, any>;
    expect(Object.keys(props).sort()).toEqual(["dryRun", "ops", "targets"]);
    expect(props.ops.items.properties.op.description).toContain("update_overlay");
    expect(props.ops.items.properties.op.description).toContain("audio_duck (enable|update|disable)");
    expect(props.ops.items.properties.op.description).not.toContain("export_video");
  });

  it("retimes an overlay, adds a bound audio clip and enables a duck on it, in every piece of a folder", async () => {
    const res = await h.call("libi.apply_ops", {
      targets: { folderId: FOLDER },
      ops: RETIME_AND_DUCK(Object.fromEntries(PIECES.map((p) => [p, `song-${p}`]))),
    });
    expect(res.body.success).toBe(true);
    expect(res.body.data.written).toBe(true);
    const reports = res.body.data.pieces as { pieceId: string; status: string; changes: string[] | string; bindings: Record<string, string> }[];
    expect(reports.map((r) => r.status)).toEqual(["applied", "applied", "applied"]);

    for (const pid of PIECES) {
      const m = await onDisk(pid);
      const vid = m.overlays!.find((o) => o.id === "vid-1") as any;
      expect(vid.duration).toBe(11);
      expect(vid.trim).toEqual({ start: 0, end: 11 });
      expect((m.overlays!.find((o) => o.id === "text-1") as any).rect.y).toBe(1250);
      const music = m.audioClips!.find((c) => c.id !== "vo-1")!;
      expect(music.fileId).toBe(`song-${pid}`);
      expect(music.volume).toBe(0.4);
      expect(music.duck?.sidechainClipIds).toEqual(["vo-1"]);
      expect(music.duck?.reductionDb).toBe(-5);
      // the binding resolved to THIS piece's clip
      expect(reports.find((r) => r.pieceId === pid)!.bindings.music).toBe(music.id);
    }
    const first = reports[0].changes as string[];
    expect(first.join("\n")).toContain("overlay vid-1: duration 8→11");
    expect(first.join("\n")).toContain("overlay text-1: rect 90,1170→90,1250");
    expect(first.join("\n")).toMatch(/audio clip \$music=clip_\w+ added 0–11 vol 0.4 duck \(sidechain vo-1; -5 dB\)/);
    // a piece whose changes read the same (bound ids aside) does not repeat them
    expect(reports[1].changes).toBe("same as piece-a");
    expect(reports[2].changes).toBe("same as piece-a");
    expect(res.text.length).toBeLessThan(1500);
  });

  it("sends one refresh per query per piece, and one tool_used per op", async () => {
    await h.call("libi.apply_ops", {
      targets: { folderId: FOLDER },
      ops: RETIME_AND_DUCK(Object.fromEntries(PIECES.map((p) => [p, `song-${p}`]))),
    });
    // let fire-and-forget posts settle
    await new Promise((r) => setTimeout(r, 20));
    const refreshes = posted.filter((p) => p.path === "/api/notify" && p.body?.type === "refresh_query");
    expect(refreshes.filter((r) => r.body.queryKey === "composition")).toHaveLength(3);
    expect(refreshes.filter((r) => r.body.queryKey === "piece-state")).toHaveLength(3);
    expect(refreshes).toHaveLength(6);

    const events = posted.filter((p) => p.path === "/api/analytics/event").map((p) => p.body);
    const toolUsed = events.filter((e) => e.name === "tool_used").map((e) => e.params);
    // the call itself + exactly one per op (4), not per piece
    expect(toolUsed).toEqual(
      expect.arrayContaining([
        { tool_name: "libi.apply_ops" },
        { tool_name: "libi.update_overlay" },
        { tool_name: "libi.audio_add_clip" },
        { tool_name: "libi.audio_duck", action: "enable" },
      ]),
    );
    expect(toolUsed.filter((p) => p.tool_name === "libi.update_overlay")).toHaveLength(2);
    expect(toolUsed).toHaveLength(5);
    expect(events.filter((e) => e.name === "apply_ops_run")).toEqual([
      { name: "apply_ops_run", params: { pieces: 5, ops: 10, dry_run: false, outcome: "applied" } },
    ]);
  });

  it("dryRun reports the same changes and writes nothing", async () => {
    const before = await Promise.all(PIECES.map((p) => onDisk(p)));
    const res = await h.call("libi.apply_ops", {
      targets: { pieceIds: [...PIECES] },
      ops: RETIME_AND_DUCK(Object.fromEntries(PIECES.map((p) => [p, `song-${p}`]))),
      dryRun: true,
    });
    expect(res.body.success).toBe(true);
    expect(res.body.data.dryRun).toBe(true);
    expect(res.body.data.written).toBe(false);
    expect((res.body.data.pieces as { status: string }[]).map((p) => p.status)).toEqual(["dry_run", "dry_run", "dry_run"]);
    expect(JSON.stringify(res.body.data.pieces[0].changes)).toContain("duration 8→11");
    expect(await Promise.all(PIECES.map((p) => onDisk(p)))).toEqual(before);
    const [row] = testDb.select().from(pieces).where(eq(pieces.id, "piece-a")).all();
    expect(row.hasDraft).toBe(false);
    expect(posted.filter((p) => p.body?.type === "refresh_query")).toHaveLength(0);
  });

  it("a piece whose ids do not match is rolled back alone: no half-applied draft, the others land", async () => {
    // piece-b lost the overlay the second op edits
    const b = await onDisk("piece-b");
    b.overlays = b.overlays!.filter((o) => o.id !== "text-1");
    await saveManifest("piece-b", b);
    const beforeB = await onDisk("piece-b");

    const res = await h.call("libi.apply_ops", {
      targets: { pieceIds: [...PIECES] },
      ops: RETIME_AND_DUCK(Object.fromEntries(PIECES.map((p) => [p, `song-${p}`]))),
    });
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/1 of 3 pieces were not changed/);
    const byId = Object.fromEntries((res.body.data.pieces as any[]).map((p) => [p.pieceId, p]));
    expect(byId["piece-b"].status).toBe("rolled_back");
    expect(byId["piece-b"].errors[0]).toMatchObject({ op: 1, tool: "update_overlay" });
    expect(byId["piece-b"].errors[0].error).toMatch(/text-1/);
    expect(byId["piece-a"].status).toBe("applied");
    expect(byId["piece-c"].status).toBe("applied");

    // the first op had already retimed vid-1 in piece-b's copy: none of it reached the disk
    expect(await onDisk("piece-b")).toEqual(beforeB);
    expect((await onDisk("piece-a")).overlays!.find((o) => o.id === "vid-1")).toMatchObject({ duration: 11 });
    expect((await onDisk("piece-c")).audioClips).toHaveLength(2);
  });

  it("refuses a malformed list whole, naming the op index and the field, before writing anything", async () => {
    const before = await onDisk("piece-a");
    const res = await h.call("libi.apply_ops", {
      targets: { pieceId: "piece-a" },
      ops: [
        { op: "update_overlay", overlayId: "vid-1", duration: 11 },
        { op: "update_overlay", overlayId: "vid-1", duration: "long" },
        { op: "export_video" },
        { op: "snapshot", action: "commit" },
        { op: "audio_duck", action: "enable", clipId: "$nope", sidechainClipIds: ["vo-1"] },
        { op: "audio_add_clip", fileId: "song-piece-a", startTime: 0, rights: { class: "copyrighted" } },
        { op: "no_such_tool" },
        { op: "audio_clip" },
        { op: "update_overlay", pieceId: "piece-b", overlayId: "vid-1" },
      ],
    });
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/invalid ops/);
    expect(res.body.error).toMatch(/Nothing was changed/);
    const errors = res.body.data.errors as { op: number; field?: string; error: string }[];
    const at = (op: number) => errors.filter((e) => e.op === op);
    expect(at(0)).toEqual([]);
    expect(at(1)[0]).toMatchObject({ field: "duration" });
    expect(at(2)[0].error).toMatch(/export_video is not allowed in a batch: it starts a background job/);
    expect(at(3)[0].error).toMatch(/snapshot commit is not allowed in a batch/);
    expect(at(4)[0]).toMatchObject({ field: "clipId" });
    expect(at(4)[0].error).toMatch(/"\$nope" is not bound by an earlier op/);
    expect(at(5)[0]).toMatchObject({ field: "rights" });
    expect(at(6)[0].error).toMatch(/unknown op "no_such_tool"/);
    expect(at(7)[0]).toMatchObject({ field: "action" });
    expect(at(8)[0]).toMatchObject({ field: "pieceId" });
    expect(await onDisk("piece-a")).toEqual(before);
  });

  it("a piece id that does not exist is refused alone", async () => {
    const res = await h.call("libi.apply_ops", {
      targets: { pieceIds: ["piece-a", "ghost"] },
      ops: [{ op: "update_overlay", overlayId: "vid-1", duration: 9 }],
    });
    const byId = Object.fromEntries((res.body.data.pieces as any[]).map((p) => [p.pieceId, p]));
    expect(byId.ghost.status).toBe("refused");
    expect(byId["piece-a"].status).toBe("applied");
    expect((await onDisk("piece-a")).overlays!.find((o) => o.id === "vid-1")).toMatchObject({ duration: 9 });
  });

  it("update_piece runs after the timeline is saved, and a dry run only reports it", async () => {
    const dry = await h.call("libi.apply_ops", {
      targets: { pieceId: "piece-a" },
      ops: [{ op: "update_piece", name: "Renamed" }],
      dryRun: true,
    });
    expect(dry.body.data.pieces[0].changes).toEqual(['piece: name → "Renamed"']);
    expect(testDb.select().from(pieces).where(eq(pieces.id, "piece-a")).get()!.name).toBe("piece-a");
    const real = await h.call("libi.apply_ops", {
      targets: { pieceId: "piece-a" },
      ops: [{ op: "update_overlay", overlayId: "vid-1", duration: 5 }, { op: "update_piece", name: "Renamed" }],
    });
    expect(real.body.success).toBe(true);
    expect(testDb.select().from(pieces).where(eq(pieces.id, "piece-a")).get()!.name).toBe("Renamed");
  });

  it("a failing op after update_piece leaves the name alone too", async () => {
    const res = await h.call("libi.apply_ops", {
      targets: { pieceId: "piece-a" },
      ops: [{ op: "update_piece", name: "Never" }, { op: "update_overlay", overlayId: "missing", duration: 5 }],
    });
    expect(res.body.data.pieces[0].status).toBe("rolled_back");
    expect(testDb.select().from(pieces).where(eq(pieces.id, "piece-a")).get()!.name).toBe("piece-a");
  });

  it("a split binds its tail, and later ops reach it by name", async () => {
    const res = await h.call("libi.apply_ops", {
      targets: { pieceId: "piece-a" },
      ops: [
        { op: "audio_clip", action: "split", clipId: "vo-1", time: 4, as: "tail" },
        { op: "audio_clip", action: "update", clipId: "$tail", volume: 0.5 },
      ],
    });
    expect(res.body.success).toBe(true);
    const m = await onDisk("piece-a");
    const tailId = res.body.data.pieces[0].bindings.tail;
    expect(m.audioClips!.find((c) => c.id === tailId)).toMatchObject({ startTime: 4, volume: 0.5 });
  });

  it("an op that changes nothing leaves the piece unchanged and writes no draft", async () => {
    const res = await h.call("libi.apply_ops", {
      targets: { pieceId: "piece-a" },
      ops: [{ op: "update_overlay", overlayId: "vid-1", duration: 8 }],
    });
    expect(res.body.data.pieces[0].status).toBe("unchanged");
    expect(testDb.select().from(pieces).where(eq(pieces.id, "piece-a")).get()!.hasDraft).toBe(false);
  });
});
