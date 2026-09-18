// @vitest-environment jsdom
/**
 * QA 2026-09-18 recheck N5: a chromium-render export drew an uploaded font
 * (libi.upload_font → overlay.fontFileId) in the default face. The render
 * page loaded only the bundled faces; the preview registers uploaded ones via
 * FontFace (registry-client). `loadOverlayFonts` is that registration for a
 * whole overlay list: it awaits every referenced upload and reports the ones
 * that failed, so the render page can wait before its first frame and the
 * server can log what fell back.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const added: string[] = [];
beforeEach(() => {
  added.length = 0;
  vi.resetModules();
  (globalThis as { FontFace?: unknown }).FontFace = class {
    constructor(public family: string, public src: string) {}
    load() {
      if (this.src.includes("hang")) return new Promise(() => {}); // never settles
      if (this.src.includes("bad")) return Promise.reject(new Error("OTS parsing error"));
      return Promise.resolve(this);
    }
  };
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { add: (f: { family: string }) => added.push(f.family) },
  });
});

describe("loadOverlayFonts", () => {
  it("registers every uploaded font a text overlay references, under the family the renderer asks for", async () => {
    const { loadOverlayFonts } = await import("@/lib/fonts/registry-client");
    const { cssFamilyForFontFile } = await import("@/lib/fonts/family");
    const failed = await loadOverlayFonts([
      { kind: "text", fontFileId: "impact" },
      { kind: "text", fontFileId: "impact" },
      { kind: "text" },
      { kind: "image" },
    ] as never);
    expect(failed).toEqual([]);
    expect(added).toEqual([cssFamilyForFontFile("impact")]);
  });

  it("reports the fileIds that failed to load", async () => {
    const { loadOverlayFonts } = await import("@/lib/fonts/registry-client");
    const failed = await loadOverlayFonts([
      { kind: "text", fontFileId: "good" },
      { kind: "text", fontFileId: "bad" },
    ] as never);
    expect(failed).toEqual([{ fontFileId: "bad", reason: "OTS parsing error" }]);
  });

  // A font request that never settles (a stalled fetch) must not hang the
  // render page before its first frame: after FONT_LOAD_TIMEOUT_MS it counts
  // as a failure and the text renders in the fallback face.
  it("counts a load that never settles as a failure after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const { loadOverlayFonts, FONT_LOAD_TIMEOUT_MS } = await import("@/lib/fonts/registry-client");
      const pending = loadOverlayFonts([
        { kind: "text", fontFileId: "hang" },
        { kind: "text", fontFileId: "good" },
      ] as never);
      await vi.advanceTimersByTimeAsync(FONT_LOAD_TIMEOUT_MS);
      expect(await pending).toEqual([{ fontFileId: "hang", reason: "font load timed out" }]);
      expect(added).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

