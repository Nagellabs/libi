// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { AssetThumbnail } from "@/components/editor/asset-thumbnail";
import type { FileRecord } from "@/lib/db/schema/types";

function makeFile(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: "f1",
    pieceId: "p1",
    folderId: null,
    filename: "x.mp4",
    name: "video clip",
    description: "",
    type: "video",
    storagePath: "/tmp/x.mp4",
    contentType: "video/mp4",
    size: 1234,
    mediaDuration: 5,
    mediaWidth: 1920,
    mediaHeight: 1080,
    hasAudio: true,
    hasAlpha: false,
    proxyFilename: null,
    proxyStatus: "idle",
    proxyGeneratedAt: null,
    proxyHeight: null,
    filmstripFilename: null,
    filmstripStatus: "idle",
    filmstripGeneratedAt: null,
    filmstripFrames: null,
    filmstripHeight: null,
    falUploadedUrl: null,
    aiGeneration: null,
    notes: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("AssetThumbnail", () => {
  it("renders an <img> for image files", () => {
    const file = makeFile({ type: "image", contentType: "image/png", filename: "p.png" });
    render(<AssetThumbnail file={file} />);
    const img = screen.getByRole("img");
    expect(img.getAttribute("src")).toContain(`/api/files/by-id/${file.id}/content`);
  });

  it("renders a <video> for video files (preload metadata, muted, playsInline)", () => {
    const file = makeFile();
    const { container } = render(<AssetThumbnail file={file} />);
    const video = container.querySelector("video");
    expect(video).toBeTruthy();
    expect(video!.getAttribute("preload")).toBe("metadata");
    expect(video!.muted).toBe(true);
  });

  it("renders an icon fallback for audio files", () => {
    const file = makeFile({ type: "audio", contentType: "audio/wav", filename: "a.wav" });
    render(<AssetThumbnail file={file} />);
    expect(screen.getByTestId("asset-thumbnail-fallback")).toBeInTheDocument();
  });

  it("uses the asset display name as the image alt text", () => {
    const file = makeFile({ type: "image", contentType: "image/png", name: "my clip" });
    render(<AssetThumbnail file={file} />);
    const img = screen.getByRole("img");
    expect(img.getAttribute("alt")).toBe("my clip");
  });

  it("uses the proxy URL when proxy status is ready", () => {
    const file = makeFile({
      proxyStatus: "ready",
      proxyFilename: "x-proxy.mp4",
    });
    const { container } = render(<AssetThumbnail file={file} />);
    const video = container.querySelector("video");
    expect(video!.getAttribute("src")).toBe(`/api/files/by-id/${file.id}/proxy`);
  });
});
