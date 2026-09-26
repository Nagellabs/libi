import { describe, it, expect, vi } from "vitest";
import { errorOwner, fileIdFromUrl, makeRuntimeHelpers, runtimeLoadImage } from "@/lib/sandbox/runtime/helpers";
import { __resetImageCachesForTests } from "@/lib/engine/drawing";
import { DRAW_HELPERS } from "@/lib/engine/draw-helpers";

const bmp = { width: 1, height: 1, close() {} } as unknown as ImageBitmap;

describe("fileIdFromUrl", () => {
  it("recognises the RELATIVE piece-file content URL, with a query — and nothing that names a host (final review M1)", () => {
    expect(fileIdFromUrl("/api/files/by-id/abc-123/content")).toBe("abc-123");
    expect(fileIdFromUrl("/api/files/by-id/abc-123/content?x=1")).toBe("abc-123");
    expect(fileIdFromUrl("http://127.0.0.1:3456/api/files/by-id/abc-123/content?x=1")).toBeNull();
    expect(fileIdFromUrl("https://evil.example/api/files/by-id/abc-123/content")).toBeNull();
    expect(fileIdFromUrl("/api/files/by-id/abc-123/proxy")).toBeNull();
    expect(fileIdFromUrl("https://example.com/photo.jpg")).toBeNull();
  });
});

describe("runtimeLoadImage (spec §4.3 — data: and this piece's files only, in a worker)", () => {
  it("resolves a piece file from the transferred bitmaps", async () => {
    await expect(runtimeLoadImage("/api/files/by-id/f1/content", { f1: bmp })).resolves.toBe(bmp);
  });
  it("resolves only an OWN key: constructor and __proto__ do not reach Object.prototype (final review M1)", async () => {
    await expect(runtimeLoadImage("/api/files/by-id/constructor/content", { f1: bmp })).rejects.toThrow(/file constructor is not one of this piece's image files/);
    await expect(runtimeLoadImage("/api/files/by-id/__proto__/content", { f1: bmp })).rejects.toThrow(/file __proto__ is not one/);
    await expect(runtimeLoadImage("/api/files/by-id/hasOwnProperty/content", { f1: bmp })).rejects.toThrow(/not one of this piece's image files/);
  });
  it("rejects a piece file that was not transferred, naming the id", async () => {
    await expect(runtimeLoadImage("/api/files/by-id/f9/content", { f1: bmp })).rejects.toThrow(/file f9 is not one of this piece's image files/);
  });
  it("delegates data: URLs to the engine loader", async () => {
    const loadDom = vi.fn(async () => bmp as CanvasImageSource);
    await runtimeLoadImage("data:image/png;base64,AAAA", {}, loadDom);
    expect(loadDom).toHaveBeenCalledTimes(1);
  });
  it("rejects blob: and any other URL with a clear message (no fetch in the worker)", async () => {
    await expect(runtimeLoadImage("blob:null/abc", {})).rejects.toThrow(/only data: URLs and this piece's own files/);
    await expect(runtimeLoadImage("https://example.com/photo.jpg", {})).rejects.toThrow(/only data: URLs and this piece's own files/);
  });
});

describe("makeRuntimeHelpers", () => {
  it("keeps every documented helper and swaps loadImage for the shim", () => {
    const h = makeRuntimeHelpers(() => ({}), "o1");
    expect(Object.keys(h).sort()).toEqual(Object.keys(DRAW_HELPERS).sort());
    expect(h.loadImage).not.toBe(DRAW_HELPERS.loadImage);
    expect(h.drawTextBlock).toBe(DRAW_HELPERS.drawTextBlock);
  });
  it("tags every async helper's rejection with the overlay that called it (review I3)", async () => {
    // A rejection a body never handles reaches the worker's global
    // `unhandledrejection` long after the frame; the tag is the only thing that
    // still says whose it was.
    vi.stubGlobal("createImageBitmap", vi.fn(async () => { throw new Error("The source image could not be decoded."); }));
    try {
      const a = makeRuntimeHelpers(() => ({}), "A");
      const b = makeRuntimeHelpers(() => ({}), "B");
      const ctx = { drawImage: vi.fn() };
      const errA = await (a.drawSvg as (...x: unknown[]) => Promise<void>)(ctx, "<svg/>", 0, 0, 1, 1).catch((e: unknown) => e);
      const errB = await (b.svgToImage as (s: string) => Promise<unknown>)("<svg/>").catch((e: unknown) => e);
      const errL = await (a.loadImage as (s: string) => Promise<unknown>)("https://example.com/x.png").catch((e: unknown) => e);
      expect(errorOwner(errA)).toBe("A");
      expect(errorOwner(errB)).toBe("B");
      expect(errorOwner(errL)).toBe("A");
      expect(errorOwner(new Error("a body's own"))).toBeNull();
      expect(errorOwner("not an object")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      __resetImageCachesForTests();
    }
  });
});
