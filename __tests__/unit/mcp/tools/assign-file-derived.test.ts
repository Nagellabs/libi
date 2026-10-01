/**
 * `assignFile` moves a file's derived artifacts with its bytes. The bug this
 * pins: an agent downloaded a video to the library (`_global/`), its proxy was
 * made there, then it was assigned to a piece. Only the original moved; the
 * row still said "proxy ready", the proxy route looked in the piece folder and
 * 404'd, and the asset view showed a dead player until "View original".
 *
 * Real files on a real LocalFileStorage under a temp LIBI_HOME, so a wrong
 * scope folder actually loses the file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
vi.mock("@/lib/navigation-events", () => ({ navigationEmitter: { emit: vi.fn() } }));

import { assignFile } from "@/mcp/tools/file-tools";
import { resetStorage } from "@/lib/storage";
import { listEvictedProxies } from "@/lib/proxy/evicted";

let tmp: string;
let storage: string;

function seedLibraryVideo(opts: { proxy?: boolean; filmstrip?: boolean; analysis?: boolean } = {}) {
  const g = path.join(storage, "_global");
  fs.mkdirSync(g, { recursive: true });
  fs.writeFileSync(path.join(g, "Video_by_ysr.y0.mp4"), "original");
  if (opts.proxy) fs.writeFileSync(path.join(g, "Video_by_ysr.y0-proxy.mp4"), "proxy");
  if (opts.filmstrip) fs.writeFileSync(path.join(g, "Video_by_ysr.y0-filmstrip.jpg"), "strip");
  if (opts.analysis) {
    fs.mkdirSync(path.join(g, "_analysis", "f1", "frames"), { recursive: true });
    fs.writeFileSync(path.join(g, "_analysis", "f1", "frames", "frame-0001.png"), "frame");
  }
  testDb
    .insert(files)
    .values({
      id: "f1", pieceId: null, filename: "Video_by_ysr.y0.mp4", name: "Video_by_ysr.y0.mp4",
      description: "", type: "video", storagePath: "_global/Video_by_ysr.y0.mp4",
      contentType: "video/mp4", size: 8, mediaHeight: 1920, mediaWidth: 1080,
      proxyFilename: opts.proxy ? "Video_by_ysr.y0-proxy.mp4" : null,
      proxyStatus: opts.proxy ? "ready" : "idle",
      proxyGeneratedAt: opts.proxy ? new Date() : null,
      proxyHeight: opts.proxy ? 1080 : null,
      filmstripFilename: opts.filmstrip ? "Video_by_ysr.y0-filmstrip.jpg" : null,
      filmstripStatus: opts.filmstrip ? "ready" : "idle",
    })
    .run();
}

const row = () => testDb.select().from(files).where(eq(files.id, "f1")).all()[0];

describe("assignFile carries the proxy, filmstrip and analysis folder", () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-assign-derived-"));
    process.env.LIBI_HOME = tmp;
    storage = path.join(tmp, "storage");
    resetStorage();
    testDb = createTestDb();
    seedPiece(testDb, { id: "piece-a" });
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    resetStorage();
  });

  it("a library video assigned to a piece keeps a playable proxy in the piece folder", async () => {
    seedLibraryVideo({ proxy: true, analysis: true });

    const res = await assignFile({ fileId: "f1", pieceId: "piece-a" });
    expect(res.success).toBe(true);

    const r = row();
    expect(r.pieceId).toBe("piece-a");
    expect(r.proxyStatus).toBe("ready");
    expect(r.proxyFilename).toBe("Video_by_ysr.y0-proxy.mp4");
    // What the proxy route checks: the proxy under the row's CURRENT scope.
    expect(fs.readFileSync(path.join(storage, "piece-a", r.proxyFilename!), "utf8")).toBe("proxy");
    expect(fs.existsSync(path.join(storage, "_global", "Video_by_ysr.y0-proxy.mp4"))).toBe(false);
    // The analysis frames followed it too.
    expect(fs.existsSync(path.join(storage, "piece-a", "_analysis", "f1", "frames", "frame-0001.png"))).toBe(true);
    expect(fs.existsSync(path.join(storage, "_global", "_analysis", "f1"))).toBe(false);
  });

  it("the proxy is renamed after a deduped destination filename", async () => {
    seedLibraryVideo({ proxy: true });
    fs.mkdirSync(path.join(storage, "piece-a"), { recursive: true });
    fs.writeFileSync(path.join(storage, "piece-a", "Video_by_ysr.y0.mp4"), "other");
    testDb
      .insert(files)
      .values({
        id: "other", pieceId: "piece-a", filename: "Video_by_ysr.y0.mp4", name: "x", description: "",
        type: "video", storagePath: "piece-a/Video_by_ysr.y0.mp4", contentType: "video/mp4", size: 5,
      })
      .run();

    await assignFile({ fileId: "f1", pieceId: "piece-a" });

    const r = row();
    expect(r.filename).toBe("Video_by_ysr.y0 (1).mp4");
    expect(r.proxyFilename).toBe("Video_by_ysr.y0 (1)-proxy.mp4");
    expect(fs.readFileSync(path.join(storage, "piece-a", r.proxyFilename!), "utf8")).toBe("proxy");
  });

  it("a 'ready' proxy that is already gone goes idle and is queued to be re-made, never left 'ready'", async () => {
    seedLibraryVideo({ proxy: true });
    fs.rmSync(path.join(storage, "_global", "Video_by_ysr.y0-proxy.mp4"));

    await assignFile({ fileId: "f1", pieceId: "piece-a" });

    const r = row();
    expect(r.proxyStatus).toBe("idle");
    expect(r.proxyFilename).toBeNull();
    expect(listEvictedProxies().f1).toBeDefined();
  });

  it("a destination proxy name another file already holds is never overwritten", async () => {
    seedLibraryVideo({ proxy: true });
    fs.mkdirSync(path.join(storage, "piece-a"), { recursive: true });
    fs.writeFileSync(path.join(storage, "piece-a", "Video_by_ysr.y0-proxy.mp4"), "someone else's");

    await assignFile({ fileId: "f1", pieceId: "piece-a" });

    expect(fs.readFileSync(path.join(storage, "piece-a", "Video_by_ysr.y0-proxy.mp4"), "utf8")).toBe("someone else's");
    const r = row();
    expect(r.proxyStatus).toBe("idle");
    expect(r.proxyFilename).toBeNull();
  });

  it("the filmstrip is dropped (the timeline re-makes it), not left pointing at the old folder", async () => {
    seedLibraryVideo({ filmstrip: true });

    await assignFile({ fileId: "f1", pieceId: "piece-a" });

    const r = row();
    expect(r.filmstripStatus).toBe("idle");
    expect(r.filmstripFilename).toBeNull();
    expect(fs.existsSync(path.join(storage, "_global", "Video_by_ysr.y0-filmstrip.jpg"))).toBe(false);
  });
});
