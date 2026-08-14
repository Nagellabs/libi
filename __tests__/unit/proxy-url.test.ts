/**
 * Unit: pickVideoUrl — decides whether the preview reads the original
 * or the proxy file for a given FileRecord. Called from buildComposition
 * per video scene and must match in every caller.
 */
import { describe, it, expect } from "vitest";
import { pickVideoUrl } from "@/lib/proxy/url";
import type { FileRecord } from "@/lib/db/schema/types";

function rec(overrides: Partial<FileRecord>): FileRecord {
  return {
    id: "file-1",
    pieceId: "p1",
    filename: "clip.mp4",
    name: "clip",
    description: "",
    type: "video",
    storagePath: "p1/clip.mp4",
    contentType: "video/mp4",
    size: 0,
    mediaDuration: null,
    mediaWidth: null,
    mediaHeight: null,
    proxyFilename: null,
    proxyStatus: "idle",
    proxyGeneratedAt: null,
    createdAt: new Date(0),
    ...overrides,
  } as FileRecord;
}

describe("pickVideoUrl", () => {
  it("returns the original URL for idle files", () => {
    expect(pickVideoUrl(rec({ proxyStatus: "idle" }))).toBe(
      "/api/files/by-id/file-1/content",
    );
  });

  it("returns the original URL while generating", () => {
    expect(pickVideoUrl(rec({ proxyStatus: "generating" }))).toBe(
      "/api/files/by-id/file-1/content",
    );
  });

  it("returns the proxy URL when ready", () => {
    expect(pickVideoUrl(rec({ proxyStatus: "ready", proxyFilename: "clip-proxy.mp4" }))).toBe(
      "/api/files/by-id/file-1/proxy",
    );
  });

  it("returns the original URL on failed", () => {
    expect(pickVideoUrl(rec({ proxyStatus: "failed" }))).toBe(
      "/api/files/by-id/file-1/content",
    );
  });

  it("NEVER returns the proxy for a VPx-alpha (WebM) video, even when ready", () => {
    // Proxies are H.264 yuv420p — no alpha plane. Serving one for a VP9-alpha
    // cutout silently restores the original background (alphamerge keeps the
    // RGB planes intact). A pre-fix cutout row can still carry a ready proxy;
    // hasAlpha must win over proxyStatus.
    expect(
      pickVideoUrl(
        rec({
          hasAlpha: true,
          filename: "clip-cutout.webm",
          proxyStatus: "ready",
          proxyFilename: "clip-cutout-proxy.mp4",
          contentType: "video/webm",
        }),
      ),
    ).toBe("/api/files/by-id/file-1/content");
  });

  it("returns the proxy for NON-VPx alpha (ProRes-style .mov) when ready", () => {
    // Preview can't recover non-VPx alpha from the original anyway (WebCodecs
    // generally can't decode ProRes/qtrle) — the opaque scrub proxy is the
    // only thing that previews at all. Exports read the ORIGINAL regardless.
    expect(
      pickVideoUrl(
        rec({
          hasAlpha: true,
          filename: "graphics.mov",
          proxyStatus: "ready",
          proxyFilename: "graphics-proxy.mp4",
          contentType: "video/quicktime",
        }),
      ),
    ).toBe("/api/files/by-id/file-1/proxy");
  });
});
