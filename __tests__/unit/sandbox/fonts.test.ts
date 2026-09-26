import { describe, it, expect, vi, beforeEach } from "vitest";
import { collectSandboxFonts, fontFileIdsOf, resetSandboxFontCacheForTests } from "@/lib/sandbox/fonts";
import { collectSandboxImages } from "@/lib/sandbox/images";
import { BUNDLED_FONTS } from "@/lib/fonts/bundled";
import type { Overlay } from "@/lib/engine/types";

const text = (id: string, fontFileId?: string) =>
  ({ id, kind: "text", content: "x", startTime: 0, duration: 1, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 1, height: 1 }, ...(fontFileId ? { fontFileId } : {}) }) as unknown as Overlay;
const image = (id: string, fileId: string) =>
  ({ id, kind: "image", fileId, startTime: 0, duration: 1, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 1, height: 1 } }) as unknown as Overlay;
const trackedImage = (id: string, fileId: string) =>
  ({ id, kind: "tracked", trackId: "t", content: { kind: "image", fileId }, startTime: 0, duration: 1, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 1, height: 1 } }) as unknown as Overlay;

beforeEach(() => resetSandboxFontCacheForTests());

describe("collectSandboxFonts (spec §4.8)", () => {
  it("fetches every bundled face plus each referenced uploaded font once, as ArrayBuffers with the exact family names", async () => {
    const fetchBuffer = vi.fn(async (url: string) => new TextEncoder().encode(url).buffer as ArrayBuffer);
    const fonts = await collectSandboxFonts([text("a", "f1"), text("b", "f1"), text("c")], fetchBuffer);
    expect(fonts).toHaveLength(BUNDLED_FONTS.length + 1);
    expect(fonts.slice(0, BUNDLED_FONTS.length).map((f) => [f.family, f.weight])).toEqual(BUNDLED_FONTS.map((f) => [f.family, f.weight]));
    expect(fonts.at(-1)).toMatchObject({ family: "libifont-f1", weight: 400 });
    expect(fetchBuffer).toHaveBeenCalledTimes(BUNDLED_FONTS.length + 1);
    expect(fetchBuffer).toHaveBeenCalledWith("/fonts/2d/Inter-Bold.ttf");
    expect(fetchBuffer).toHaveBeenCalledWith("/api/files/by-id/f1/content");
    // Second call: everything is cached, nothing re-fetched.
    await collectSandboxFonts([text("a", "f1")], fetchBuffer);
    expect(fetchBuffer).toHaveBeenCalledTimes(BUNDLED_FONTS.length + 1);
  });

  it("hands over a real ArrayBuffer — the protocol's `instanceof ArrayBuffer` guard nulls a whole load on a Uint8Array", async () => {
    const fonts = await collectSandboxFonts([text("a", "f1")], async () => new Uint8Array([1, 2, 3]).buffer);
    expect(fonts.length).toBeGreaterThan(0);
    for (const f of fonts) {
      expect(f.data).toBeInstanceOf(ArrayBuffer);
      expect(ArrayBuffer.isView(f.data)).toBe(false);
    }
  });

  it("skips a face whose fetch fails instead of failing the load, and retries it next time", async () => {
    let fail = true;
    const fetchBuffer = vi.fn(async (url: string) => {
      if (url.includes("f9") && fail) throw new Error("404");
      return new ArrayBuffer(1);
    });
    const fonts = await collectSandboxFonts([text("a", "f9")], fetchBuffer);
    expect(fonts.some((f) => f.family === "libifont-f9")).toBe(false);
    fail = false;
    const again = await collectSandboxFonts([text("a", "f9")], fetchBuffer);
    expect(again.some((f) => f.family === "libifont-f9")).toBe(true);
  });

  it("fontFileIdsOf lists distinct uploaded ids", () => {
    expect(fontFileIdsOf([text("a", "f1"), text("b", "f1"), text("c", "f2")])).toEqual(["f1", "f2"]);
  });
});

describe("collectSandboxImages (spec §4.8)", () => {
  it("keys bitmaps by fileId from the image elements the host already resolved (by overlayId)", async () => {
    const imgA = { complete: true, naturalWidth: 10 } as unknown as HTMLImageElement;
    const makeBitmap = vi.fn(async (img: HTMLImageElement) => ({ img, width: 1, height: 1, close() {} }) as unknown as ImageBitmap);
    const out = await collectSandboxImages([image("o1", "fA"), image("o2", "fA"), image("o3", "fB")], { o1: imgA, o2: imgA }, makeBitmap);
    expect(Object.keys(out)).toEqual(["fA"]); // fB has no resolved element yet
    expect(makeBitmap).toHaveBeenCalledTimes(1);
  });

  it("includes a tracked overlay's image content", async () => {
    const img = { complete: true, naturalWidth: 10 } as unknown as HTMLImageElement;
    const out = await collectSandboxImages([trackedImage("o1", "fT")], { o1: img }, async () => ({ width: 1, height: 1, close() {} }) as unknown as ImageBitmap);
    expect(Object.keys(out)).toEqual(["fT"]);
  });

  it("skips an element that has not finished loading, and one whose conversion throws", async () => {
    const pending = { complete: false, naturalWidth: 0 } as unknown as HTMLImageElement;
    const tainted = { complete: true, naturalWidth: 5 } as unknown as HTMLImageElement;
    const out = await collectSandboxImages(
      [image("o1", "fA"), image("o2", "fB")],
      { o1: pending, o2: tainted },
      vi.fn(async () => {
        throw new Error("tainted");
      }),
    );
    expect(out).toEqual({});
  });
});
