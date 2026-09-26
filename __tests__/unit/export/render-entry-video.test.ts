// lib/export/render-entry-video.ts — the export's video sources (F13, final review). A video whose
// original AND proxy both fail to load used to be left out of the export silently: the job
// succeeded, the clip was just not in it. It is now reported in `droppedOverlays`, the list the
// export result already carries for overlays it could not draw.
import { describe, it, expect, vi } from "vitest";
import { loadVideoSourcesWithDeps, mergeDroppedOverlays } from "@/lib/export/render-entry-video";
import type { Overlay } from "@/lib/engine/types";

const rect = { x: 0, y: 0, width: 100, height: 50 };
const video = (id: string, fileId: string): Overlay =>
  ({ id, kind: "video", startTime: 0, duration: 1, z: 0, rect, opacity: 1, fileId }) as Overlay;

function fakeSource(ok: boolean, message = "decode failed") {
  return { whenReady: vi.fn(async () => { if (!ok) throw new Error(message); }), dispose: vi.fn() };
}

describe("loadVideoSourcesWithDeps", () => {
  it("uses the original, then the proxy", async () => {
    const made: string[] = [];
    const createSource = vi.fn((url: string) => {
      made.push(url);
      return fakeSource(!(url.includes("/f2/content")));
    });
    const { sources, dropped } = await loadVideoSourcesWithDeps([video("a", "f1"), video("b", "f2")], { createSource, warn: vi.fn() });
    expect(Object.keys(sources).sort()).toEqual(["a", "b"]);
    expect(made).toContain("/api/files/by-id/f2/proxy");
    expect(dropped).toEqual([]);
  });

  it("a video whose original and proxy both fail is DROPPED with a reason, not left out silently", async () => {
    const abandoned: Array<ReturnType<typeof fakeSource>> = [];
    const createSource = vi.fn((url: string) => {
      const s = fakeSource(false, url.endsWith("/proxy") ? "proxy 404" : "unsupported codec");
      abandoned.push(s);
      return s;
    });
    const { sources, dropped } = await loadVideoSourcesWithDeps([video("clip", "f9")], { createSource, warn: vi.fn() });
    expect(sources).toEqual({});
    expect(dropped).toHaveLength(1);
    expect(dropped[0].id).toBe("clip");
    expect(dropped[0].message).toMatch(/could not be loaded/i);
    expect(dropped[0].message).toContain("proxy 404");
    for (const s of abandoned) expect(s.dispose).toHaveBeenCalled();
  });
});

describe("mergeDroppedOverlays", () => {
  it("keeps the render's own drops and adds the load failures, one entry per overlay", () => {
    expect(
      mergeDroppedOverlays([{ id: "code1", message: "threw" }], [{ id: "clip", message: "not loaded" }, { id: "code1", message: "dup" }]),
    ).toEqual([
      { id: "code1", message: "threw" },
      { id: "clip", message: "not loaded" },
    ]);
    expect(mergeDroppedOverlays(undefined, [])).toEqual([]);
  });
});
