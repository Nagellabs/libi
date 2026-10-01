/**
 * C1 regression — `clonePieceInto` must propagate `hasAlpha`.
 *
 * `has_alpha` is written at exactly one site (`storeFile`); the clone path
 * copies file rows field-by-field, and dropping `hasAlpha` lands the cloned
 * cutout as NULL — which every consumer reads as OPAQUE. That silently
 * reintroduces the original B1 defect in the duplicated piece: the cutout
 * exports as an opaque rectangle, and a later rename regenerates an
 * alpha-stripping proxy.
 *
 * Belt and braces: an alpha row must also NOT carry a stale proxy into the
 * clone — any proxy on an alpha row predates alpha-awareness and is
 * alpha-stripped (i.e. the original video, background and all).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";
import { getDb } from "@/lib/db/client";
import { pieces, files } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-dup-alpha-"));
  process.env.LIBI_HOME = tmp;
  delete process.env.STORAGE_DIR;
  createTestDb();
});
afterEach(() => {
  resetTestDb();
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("clonePieceInto — hasAlpha propagation", () => {
  it("preserves hasAlpha=true on the cloned row and does NOT carry a stale proxy", async () => {
    const { clonePieceInto } = await import("@/lib/duplication/clone-piece");
    const { getStorage } = await import("@/lib/storage");
    const db = getDb();
    const storage = await getStorage();

    seedPiece(db as never, { id: "src" });
    db.insert(files).values({
      id: crypto.randomUUID(),
      pieceId: "src",
      filename: "cutout.webm",
      name: "cutout",
      description: "",
      type: "video",
      storagePath: "src/cutout.webm",
      contentType: "video/webm",
      size: 4,
      hasAlpha: true,
      // Stale pre-alpha-awareness proxy: alpha-stripped, must not be carried.
      proxyFilename: "cutout-proxy.mp4",
      proxyStatus: "ready",
      proxyGeneratedAt: new Date(),
    }).run();
    await storage.save("src", "cutout.webm", Buffer.from("webm"), "video/webm");
    await storage.save("src", "cutout-proxy.mp4", Buffer.from("proxy"));

    db.insert(pieces).values({ id: "dst", name: "src (copy)" }).run();
    await clonePieceInto("src", "dst", "draft");

    const [cloned] = db.select().from(files).where(eq(files.pieceId, "dst")).all();
    expect(cloned.hasAlpha).toBe(true);
    // The stale alpha-stripped proxy must not follow the clone.
    expect(cloned.proxyFilename).toBeNull();
    expect(cloned.proxyStatus).toBe("idle");
    expect(cloned.proxyGeneratedAt).toBeNull();
    expect(await storage.exists("dst", "cutout-proxy.mp4")).toBe(false);
    // Original bytes DO follow.
    expect(await storage.exists("dst", "cutout.webm")).toBe(true);
  });

  it("preserves hasAlpha=false and keeps carrying the proxy for opaque rows", async () => {
    const { clonePieceInto } = await import("@/lib/duplication/clone-piece");
    const { getStorage } = await import("@/lib/storage");
    const db = getDb();
    const storage = await getStorage();

    seedPiece(db as never, { id: "src" });
    db.insert(files).values({
      id: crypto.randomUUID(),
      pieceId: "src",
      filename: "clip.mp4",
      name: "clip",
      description: "",
      type: "video",
      storagePath: "src/clip.mp4",
      contentType: "video/mp4",
      size: 4,
      hasAlpha: false,
      proxyFilename: "clip-proxy.mp4",
      proxyStatus: "ready",
    }).run();
    await storage.save("src", "clip.mp4", Buffer.from("mp4"), "video/mp4");
    await storage.save("src", "clip-proxy.mp4", Buffer.from("proxy"));

    db.insert(pieces).values({ id: "dst", name: "src (copy)" }).run();
    await clonePieceInto("src", "dst", "draft");

    const [cloned] = db.select().from(files).where(eq(files.pieceId, "dst")).all();
    expect(cloned.hasAlpha).toBe(false);
    expect(cloned.proxyFilename).toBe("clip-proxy.mp4");
    expect(cloned.proxyStatus).toBe("ready");
    expect(await storage.exists("dst", "clip-proxy.mp4")).toBe(true);
  });

  it("carries the proxy for a NON-VPx alpha row (ProRes-style .mov)", async () => {
    // Only the VPx/WebM family's proxy is worse-than-nothing (alpha-stripped
    // = original with its background back). A ProRes-4444-style alpha row's
    // opaque scrub proxy is the only thing that previews at all — keep it.
    const { clonePieceInto } = await import("@/lib/duplication/clone-piece");
    const { getStorage } = await import("@/lib/storage");
    const db = getDb();
    const storage = await getStorage();

    seedPiece(db as never, { id: "src" });
    db.insert(files).values({
      id: crypto.randomUUID(),
      pieceId: "src",
      filename: "graphics.mov",
      name: "graphics",
      description: "",
      type: "video",
      storagePath: "src/graphics.mov",
      contentType: "video/quicktime",
      size: 4,
      hasAlpha: true,
      proxyFilename: "graphics-proxy.mp4",
      proxyStatus: "ready",
      proxyGeneratedAt: new Date(),
    }).run();
    await storage.save("src", "graphics.mov", Buffer.from("mov"), "video/quicktime");
    await storage.save("src", "graphics-proxy.mp4", Buffer.from("proxy"));

    db.insert(pieces).values({ id: "dst", name: "src (copy)" }).run();
    await clonePieceInto("src", "dst", "draft");

    const [cloned] = db.select().from(files).where(eq(files.pieceId, "dst")).all();
    expect(cloned.hasAlpha).toBe(true);
    expect(cloned.proxyFilename).toBe("graphics-proxy.mp4");
    expect(cloned.proxyStatus).toBe("ready");
    expect(await storage.exists("dst", "graphics-proxy.mp4")).toBe(true);
  });

  it("leaves hasAlpha NULL (unknown) as NULL rather than inventing a value", async () => {
    const { clonePieceInto } = await import("@/lib/duplication/clone-piece");
    const { getStorage } = await import("@/lib/storage");
    const db = getDb();
    const storage = await getStorage();

    seedPiece(db as never, { id: "src" });
    db.insert(files).values({
      id: crypto.randomUUID(),
      pieceId: "src",
      filename: "old.mp4",
      name: "old",
      description: "",
      type: "video",
      storagePath: "src/old.mp4",
      size: 4,
    }).run();
    await storage.save("src", "old.mp4", Buffer.from("mp4"), "video/mp4");

    db.insert(pieces).values({ id: "dst", name: "src (copy)" }).run();
    await clonePieceInto("src", "dst", "draft");

    const [cloned] = db.select().from(files).where(eq(files.pieceId, "dst")).all();
    expect(cloned.hasAlpha).toBeNull();
  });
});

/**
 * EXP-1 — a duplicated piece keeps what the source had already paid for: the
 * probed proxy height (without it the clone reads as "proxy of unknown size"
 * and the resolution-aware regen re-makes a proxy that was fine) and a READY
 * filmstrip (without it every timeline bar in the copy is blank until a
 * regeneration runs). Both ride the same carryProxy guard: a VPx-alpha row
 * gets neither — its proxy (and any filmstrip sampled from it) predates
 * alpha-awareness and shows the background the user removed.
 */
describe("clonePieceInto — proxy size and filmstrip", () => {
  async function seedVideo(opts: {
    filename: string;
    contentType: string;
    hasAlpha: boolean;
    filmstripStatus?: "idle" | "generating" | "ready" | "failed";
  }) {
    const { getStorage } = await import("@/lib/storage");
    const db = getDb();
    const storage = await getStorage();
    const base = opts.filename.replace(/\.[^.]+$/, "");
    seedPiece(db as never, { id: "src" });
    const generatedAt = new Date(1_700_000_000_000);
    db.insert(files).values({
      id: crypto.randomUUID(),
      pieceId: "src",
      filename: opts.filename,
      name: base,
      description: "",
      type: "video",
      storagePath: `src/${opts.filename}`,
      contentType: opts.contentType,
      size: 4,
      mediaHeight: 2160,
      hasAlpha: opts.hasAlpha,
      proxyFilename: `${base}-proxy.mp4`,
      proxyStatus: "ready",
      proxyGeneratedAt: generatedAt,
      proxyHeight: 1080,
      filmstripFilename: `${base}-filmstrip.jpg`,
      filmstripStatus: opts.filmstripStatus ?? "ready",
      filmstripGeneratedAt: generatedAt,
      filmstripFrames: 20,
      filmstripHeight: 60,
    }).run();
    await storage.save("src", opts.filename, Buffer.from("orig"), opts.contentType);
    await storage.save("src", `${base}-proxy.mp4`, Buffer.from("proxy"));
    await storage.save("src", `${base}-filmstrip.jpg`, Buffer.from("jpg"), "image/jpeg");
    db.insert(pieces).values({ id: "dst", name: "src (copy)" }).run();
    return { storage, db, generatedAt, base };
  }

  it("carries proxyHeight and a ready filmstrip (file + columns) for an opaque video", async () => {
    const { clonePieceInto } = await import("@/lib/duplication/clone-piece");
    const { storage, db, generatedAt } = await seedVideo({
      filename: "clip.mp4", contentType: "video/mp4", hasAlpha: false,
    });
    await clonePieceInto("src", "dst", "draft");

    const [cloned] = db.select().from(files).where(eq(files.pieceId, "dst")).all();
    expect(cloned.proxyHeight).toBe(1080);
    expect(cloned.filmstripFilename).toBe("clip-filmstrip.jpg");
    expect(cloned.filmstripStatus).toBe("ready");
    expect(cloned.filmstripGeneratedAt?.getTime()).toBe(generatedAt.getTime());
    expect(cloned.filmstripFrames).toBe(20);
    expect(cloned.filmstripHeight).toBe(60);
    expect(await storage.exists("dst", "clip-filmstrip.jpg")).toBe(true);
    expect((await storage.read("dst", "clip-filmstrip.jpg")).toString()).toBe("jpg");
  });

  it("does not carry a filmstrip that isn't ready", async () => {
    const { clonePieceInto } = await import("@/lib/duplication/clone-piece");
    const { storage, db } = await seedVideo({
      filename: "clip.mp4", contentType: "video/mp4", hasAlpha: false, filmstripStatus: "failed",
    });
    await clonePieceInto("src", "dst", "draft");

    const [cloned] = db.select().from(files).where(eq(files.pieceId, "dst")).all();
    expect(cloned.filmstripFilename).toBeNull();
    expect(cloned.filmstripStatus).toBe("idle");
    expect(cloned.filmstripFrames).toBeNull();
    expect(cloned.filmstripHeight).toBeNull();
    expect(await storage.exists("dst", "clip-filmstrip.jpg")).toBe(false);
    // The proxy height still rides the proxy.
    expect(cloned.proxyHeight).toBe(1080);
  });

  it("gives a VPx-alpha row neither the proxy height nor the filmstrip (B1 guard)", async () => {
    const { clonePieceInto } = await import("@/lib/duplication/clone-piece");
    const { storage, db } = await seedVideo({
      filename: "cutout.webm", contentType: "video/webm", hasAlpha: true,
    });
    await clonePieceInto("src", "dst", "draft");

    const [cloned] = db.select().from(files).where(eq(files.pieceId, "dst")).all();
    expect(cloned.proxyFilename).toBeNull();
    expect(cloned.proxyHeight).toBeNull();
    expect(cloned.filmstripFilename).toBeNull();
    expect(cloned.filmstripStatus).toBe("idle");
    expect(cloned.filmstripGeneratedAt).toBeNull();
    expect(cloned.filmstripFrames).toBeNull();
    expect(cloned.filmstripHeight).toBeNull();
    expect(await storage.exists("dst", "cutout-filmstrip.jpg")).toBe(false);
  });

  // FINAL m-B1: the columns followed carryProxy while the bytes followed the
  // file's existence, so a ready row whose proxy file was gone cloned as a
  // ready row pointing at nothing.
  it("a ready row whose proxy file is missing clones as idle with no proxy fields", async () => {
    const { clonePieceInto } = await import("@/lib/duplication/clone-piece");
    const { storage, db } = await seedVideo({
      filename: "clip.mp4", contentType: "video/mp4", hasAlpha: false,
    });
    await storage.delete("src", "clip-proxy.mp4");
    await clonePieceInto("src", "dst", "draft");

    const [cloned] = db.select().from(files).where(eq(files.pieceId, "dst")).all();
    expect(cloned.proxyFilename).toBeNull();
    expect(cloned.proxyStatus).toBe("idle");
    expect(cloned.proxyGeneratedAt).toBeNull();
    expect(cloned.proxyHeight).toBeNull();
    expect(await storage.exists("dst", "clip-proxy.mp4")).toBe(false);
  });

  it("an evicted source proxy is recorded for the clone", async () => {
    const { clonePieceInto } = await import("@/lib/duplication/clone-piece");
    const { recordEvictedProxy, listEvictedProxies } = await import("@/lib/proxy/evicted");
    const { storage, db } = await seedVideo({
      filename: "clip.mp4", contentType: "video/mp4", hasAlpha: false,
    });
    // What dropProxyFile(…, "lru") leaves: an idle row, no proxy file, a record.
    const [srcRow] = db.select().from(files).where(eq(files.pieceId, "src")).all();
    db.update(files)
      .set({ proxyFilename: null, proxyStatus: "idle", proxyGeneratedAt: null, proxyHeight: null })
      .where(eq(files.id, srcRow.id))
      .run();
    await storage.delete("src", "clip-proxy.mp4");
    recordEvictedProxy(srcRow.id, 123);
    await clonePieceInto("src", "dst", "draft");

    const [cloned] = db.select().from(files).where(eq(files.pieceId, "dst")).all();
    expect(listEvictedProxies()[cloned.id]?.bytes).toBe(123);
    // The source keeps its own record.
    expect(listEvictedProxies()[srcRow.id]?.bytes).toBe(123);
  });

  it("a VPx-alpha source's eviction record is not carried (B1 guard)", async () => {
    const { clonePieceInto } = await import("@/lib/duplication/clone-piece");
    const { recordEvictedProxy, listEvictedProxies } = await import("@/lib/proxy/evicted");
    const { db } = await seedVideo({
      filename: "cutout.webm", contentType: "video/webm", hasAlpha: true,
    });
    const [srcRow] = db.select().from(files).where(eq(files.pieceId, "src")).all();
    recordEvictedProxy(srcRow.id, 123);
    await clonePieceInto("src", "dst", "draft");

    const [cloned] = db.select().from(files).where(eq(files.pieceId, "dst")).all();
    expect(listEvictedProxies()[cloned.id]).toBeUndefined();
  });
});
