import { describe, it, expect, vi, afterEach } from "vitest";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import {
  loadImage,
  svgToImage,
  __resetImageCachesForTests,
  IMAGE_CACHE_MAX_ENTRIES,
  IMAGE_CACHE_MAX_BYTES,
  SVG_REFUSED_MAX_ENTRIES,
} from "@/lib/engine/drawing";

/** Node has no `Image`: this IS the worker environment as far as drawing.ts
 *  can tell. `createImageBitmap` is stubbed so the decode call is observable. */
afterEach(() => {
  vi.unstubAllGlobals();
  __resetImageCachesForTests();
});

describe("drawing.ts without a DOM (the sandbox worker)", () => {
  it("svgToImage still ATTEMPTS createImageBitmap on an image/svg+xml blob, and caches a success", async () => {
    // No Chromium rasterizes SVG off the main thread today (measured 2026-09-23,
    // Chrome 147.0.7727.15 — see the comment in drawing.ts). The attempt stays so the
    // day one does, it works; this pins that it is really attempted.
    const bitmap = { width: 8, height: 8, close() {} };
    const create = vi.fn(async (blob: Blob) => { expect(blob.type).toBe("image/svg+xml"); return bitmap; });
    vi.stubGlobal("createImageBitmap", create);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';
    expect(await svgToImage(svg)).toBe(bitmap);
    expect(await svgToImage(svg)).toBe(bitmap);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("turns the browser's opaque SVG decode refusal into a message that tells the author what to do instead", async () => {
    // What Chromium actually throws is `InvalidStateError: The source image
    // could not be decoded.` — which reaches the agent as a render diagnostic
    // and says nothing about SVG, the sandbox, or the way out.
    vi.stubGlobal("createImageBitmap", vi.fn(async () => {
      throw Object.assign(new Error("The source image could not be decoded."), { name: "InvalidStateError" });
    }));
    await expect(svgToImage('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>')).rejects.toThrow(
      /does not rasterize SVG off the main thread/,
    );
  });
  it("remembers an SVG the browser refused: later calls reject at once, each with its OWN error object (review I3)", async () => {
    // Every frame of a drawSvg body re-attempted the decode. The error must be
    // fresh per call: the runtime tags each rejection with the overlay that
    // asked, and one shared object would carry the last asker's tag.
    const create = vi.fn(async () => { throw new Error("The source image could not be decoded."); });
    vi.stubGlobal("createImageBitmap", create);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const first = await svgToImage(svg).catch((e: unknown) => e);
    const second = await svgToImage(svg).catch((e: unknown) => e);
    expect(create).toHaveBeenCalledTimes(1);
    expect(second).toBeInstanceOf(Error);
    expect((second as Error).message).toMatch(/does not rasterize SVG off the main thread/);
    expect(second).not.toBe(first);
  });
  it("a malformed data: URL is a REJECTION, never a synchronous throw a body's .catch would miss (review minor 3)", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1, height: 1, close() {} })));
    for (const bad of ["data:image/png;base64", "data:image/png;base64,%%%not-base64", "data:text/plain,%E0%A4%A"]) {
      let p: Promise<unknown> | undefined;
      expect(() => { p = loadImage(bad); }, bad).not.toThrow();
      await expect(p, bad).rejects.toThrow();
    }
  });
  it("loadImage decodes a data: URL through createImageBitmap without fetch", async () => {
    const bitmap = { width: 1, height: 1, close() {} };
    const create = vi.fn(async (blob: Blob) => { expect(blob.type).toBe("image/png"); return bitmap; });
    vi.stubGlobal("createImageBitmap", create);
    vi.stubGlobal("fetch", () => { throw new Error("fetch must not be called"); });
    expect(await loadImage("data:image/png;base64,iVBORw0KGgo=")).toBe(bitmap);
  });
  it("loadImage on a non-data URL without an Image rejects clearly", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn());
    await expect(loadImage("https://example.com/a.png")).rejects.toThrow(/no Image in this environment/);
  });
});

/** Task 7 review minor 9: the worker's caches are module-level, shared by every
 *  body, and lived as long as the worker — one body decoding fresh `data:` URLs
 *  grew them without limit. */
describe("drawing.ts caches are bounded (Task 12b)", () => {
  const url = (i: number) => `data:image/png;base64,${btoa(`img-${i}`)}`;
  function stubDecode(side = 1) {
    const made: Array<{ width: number; height: number; close: ReturnType<typeof vi.fn> }> = [];
    const create = vi.fn(async () => {
      const b = { width: side, height: side, close: vi.fn() };
      made.push(b);
      return b;
    });
    vi.stubGlobal("createImageBitmap", create);
    return { made, create };
  }

  it("keeps at most IMAGE_CACHE_MAX_ENTRIES images, evicting the least recently used — dropped, never closed", async () => {
    const { made, create } = stubDecode();
    for (let i = 0; i < IMAGE_CACHE_MAX_ENTRIES; i++) await loadImage(url(i));
    await loadImage(url(0)); // a hit: url(0) is now the most recently used
    expect(create).toHaveBeenCalledTimes(IMAGE_CACHE_MAX_ENTRIES);
    await loadImage(url(IMAGE_CACHE_MAX_ENTRIES)); // one over: url(1) goes
    // A body may still hold it (fix round 1, ruling 3): the GC reclaims it.
    for (const b of made) expect(b.close).not.toHaveBeenCalled();
    await loadImage(url(0));
    expect(create).toHaveBeenCalledTimes(IMAGE_CACHE_MAX_ENTRIES + 1); // still cached
    await loadImage(url(1));
    expect(create).toHaveBeenCalledTimes(IMAGE_CACHE_MAX_ENTRIES + 2); // decoded again
  });

  it("keeps the decoded pixels under IMAGE_CACHE_MAX_BYTES", async () => {
    const side = 4096; // 64 MiB of RGBA each
    const perImage = side * side * 4;
    const fit = Math.floor(IMAGE_CACHE_MAX_BYTES / perImage) - 1; // keys take a few bytes too
    const { made, create } = stubDecode(side);
    for (let i = 0; i < fit; i++) await loadImage(url(i));
    await loadImage(url(fit));
    await loadImage(url(fit + 1)); // over the byte budget: url(0) goes
    await loadImage(url(fit + 1));
    expect(create).toHaveBeenCalledTimes(fit + 2); // the newest is still cached
    await loadImage(url(0));
    expect(create).toHaveBeenCalledTimes(fit + 3); // the oldest was evicted: decoded again
    for (const b of made) expect(b.close).not.toHaveBeenCalled();
  });

  it("a body that keeps an image past its eviction still draws it (fix round 1, ruling 3)", async () => {
    // A stand-in for an ImageBitmap with the browser's semantics: real pixels
    // (a @napi-rs/canvas surface), and once `close()`d it is detached — its
    // size reads 0 × 0 and drawImage throws InvalidStateError.
    type FakeBitmap = { width: number; height: number; close(): void; surface: Canvas; closed: boolean };
    const decode = vi.fn(async () => {
      const surface = createCanvas(4, 4);
      const g = surface.getContext("2d");
      g.fillStyle = "rgb(255,0,0)";
      g.fillRect(0, 0, 4, 4);
      const b: FakeBitmap = {
        width: 4, height: 4, surface, closed: false,
        close() { b.closed = true; b.width = 0; b.height = 0; },
      };
      return b;
    });
    vi.stubGlobal("createImageBitmap", decode);
    const drawImage = (dst: Canvas, img: FakeBitmap) => {
      if (img.closed) throw new DOMException("The image source is detached", "InvalidStateError");
      dst.getContext("2d").drawImage(img.surface, 0, 0);
    };

    // The body keeps what loadImage handed it, as bodies do (`let logo; ...`).
    const kept = (await loadImage(url(0))) as unknown as FakeBitmap;
    // Other loads push it out of the cache.
    for (let i = 1; i <= IMAGE_CACHE_MAX_ENTRIES; i++) await loadImage(url(i));
    await loadImage(url(0));
    expect(decode).toHaveBeenCalledTimes(IMAGE_CACHE_MAX_ENTRIES + 2); // evicted, so decoded afresh

    // Its next frame still draws the bitmap it kept.
    const layer = createCanvas(4, 4);
    expect(() => drawImage(layer, kept)).not.toThrow();
    expect(Array.from(layer.getContext("2d").getImageData(1, 1, 1, 1).data)).toEqual([255, 0, 0, 255]);
  });

  it("remembers at most SVG_REFUSED_MAX_ENTRIES refused SVG strings", async () => {
    const create = vi.fn(async () => { throw new Error("The source image could not be decoded."); });
    vi.stubGlobal("createImageBitmap", create);
    const svg = (i: number) => `<svg xmlns="http://www.w3.org/2000/svg" data-i="${i}"/>`;
    for (let i = 0; i <= SVG_REFUSED_MAX_ENTRIES; i++) await svgToImage(svg(i)).catch(() => {});
    expect(create).toHaveBeenCalledTimes(SVG_REFUSED_MAX_ENTRIES + 1);
    await svgToImage(svg(SVG_REFUSED_MAX_ENTRIES)).catch(() => {}); // remembered
    expect(create).toHaveBeenCalledTimes(SVG_REFUSED_MAX_ENTRIES + 1);
    await svgToImage(svg(0)).catch(() => {}); // forgotten: tried again
    expect(create).toHaveBeenCalledTimes(SVG_REFUSED_MAX_ENTRIES + 2);
  });
});
