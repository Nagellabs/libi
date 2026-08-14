import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub CanvasSourceBackend (browser path). Stub fetch for server paths.
vi.mock("@/lib/export/backends/canvas-source", () => ({
  CanvasSourceBackend: class {
    name = "canvas-source";
    async run() { return { blob: new Blob(), duration: 0, format: "mp4" }; }
  },
}));

const fetchMock = vi.fn(async () =>
  new Response(new Blob(["MP4"]), {
    status: 200,
    headers: { "X-Export-Duration-Seconds": "1.0" },
  }),
);
vi.stubGlobal("fetch", fetchMock);

import { exportRouter } from "@/lib/export/router";
import type { Composition, ExportSettings } from "@/lib/engine/types";

const baseSettings: ExportSettings = {
  format: "mp4", codec: "avc", bitrate: 0, width: 320, height: 240, fps: 24,
};

const commonOpts = (comp: Composition) => ({
  composition: comp,
  settings: baseSettings,
  pieceId: "piece-1",
});

describe("exportRouter", () => {
  beforeEach(() => {
    fetchMock.mockClear();
  });

  it("routes stream-copy-trim to /api/export/ffmpeg for a base video overlay with nothing on top", async () => {
    const comp: Composition = {
      id: "c", name: "", width: 320, height: 240, fps: 24,
      scenes: [],
      overlays: [{
        id: "s", kind: "video", fileId: "f", videoUrl: "",
        startTime: 0, duration: 1, z: 0, opacity: 1, fit: "cover",
        rect: { x: 0, y: 0, width: 320, height: 240 },
        sourceWidth: 320, sourceHeight: 240,
      }],
    };
    const r = await exportRouter(commonOpts(comp));
    expect(r.backend).toBe("stream-copy-trim");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/export/ffmpeg",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("routes ffmpeg-overlay to /api/export/ffmpeg for a base video overlay with a declarative overlay on top", async () => {
    const comp: Composition = {
      id: "c", name: "", width: 320, height: 240, fps: 24,
      scenes: [],
      overlays: [{
        id: "s", kind: "video", fileId: "f", videoUrl: "",
        startTime: 0, duration: 1, z: 0, opacity: 1, fit: "cover",
        rect: { x: 0, y: 0, width: 320, height: 240 },
        sourceWidth: 320, sourceHeight: 240,
      }, {
        id: "t1", kind: "text", content: "hi",
        font: "24px Inter", color: "#fff", align: "left", opacity: 1,
        rect: { x: 0, y: 0, width: 100, height: 30 },
        startTime: 0, duration: 1, z: 1,
      }],
    };
    const r = await exportRouter(commonOpts(comp));
    expect(r.backend).toBe("ffmpeg-overlay");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/export/ffmpeg",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("routes canvas-source in-browser (no fetch) for multi-scene when LIBI_EXPORT_USE_BROWSER_CANVAS=1", async () => {
    const prev = process.env.LIBI_EXPORT_USE_BROWSER_CANVAS;
    process.env.LIBI_EXPORT_USE_BROWSER_CANVAS = "1";
    try {
      const comp: Composition = {
        id: "c", name: "", width: 320, height: 240, fps: 24,
        scenes: [
          { id: "a", name: "", type: "canvas", duration: 1, draw: () => {} },
          { id: "b", name: "", type: "canvas", duration: 1, draw: () => {} },
        ],
      };
      const r = await exportRouter(commonOpts(comp));
      expect(r.backend).toBe("canvas-source");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.LIBI_EXPORT_USE_BROWSER_CANVAS;
      else process.env.LIBI_EXPORT_USE_BROWSER_CANVAS = prev;
    }
  });

  it("dispatches chromium-render via POST /api/export/chromium", async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "X-Export-Backend": "chromium-render",
            "X-Export-Duration-Seconds": "2.0",
            "Content-Type": "video/mp4",
          },
        }),
    );

    const comp: Composition = {
      id: "c", name: "", width: 320, height: 240, fps: 24,
      scenes: [
        { id: "a", name: "", type: "canvas", duration: 1, draw: () => {} },
        { id: "b", name: "", type: "canvas", duration: 1, draw: () => {} },
      ],
    };

    const result = await exportRouter(commonOpts(comp));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe("/api/export/chromium");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ pieceId: "piece-1", settings: baseSettings, source: "draft" });
    expect(result.backend).toBe("chromium-render");
    expect(result.duration).toBe(2.0);
    expect(result.format).toBe("mp4");
  });

  it("throws on empty composition", async () => {
    const comp: Composition = { id: "c", name: "", width: 1, height: 1, fps: 24, scenes: [] };
    await expect(exportRouter(commonOpts(comp))).rejects.toThrow();
  });
});
