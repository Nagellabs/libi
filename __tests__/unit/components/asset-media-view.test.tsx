// @vitest-environment jsdom
import { render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { createRef } from "react";
import { AssetMediaView } from "@/components/editor/asset-media-view";
import type { FileRecord } from "@/lib/db/schema/types";

function vid(): FileRecord {
  return {
    id: "v", pieceId: "p", folderId: null, filename: "x.mp4", name: "x", description: "",
    type: "video", storagePath: "", contentType: "video/mp4", size: 1,
    mediaDuration: 10, mediaWidth: 640, mediaHeight: 360, hasAudio: true, hasAlpha: false,
    proxyFilename: null, proxyStatus: "idle", proxyGeneratedAt: null, proxyHeight: null,
    filmstripFilename: null, filmstripStatus: "idle", filmstripGeneratedAt: null, filmstripFrames: null, filmstripHeight: null,
    falUploadedUrl: null,
    aiGeneration: null,
    notes: null,
    createdAt: new Date(),
  };
}

describe("AssetMediaView", () => {
  it("renders centered video with controls and registers it on mediaRef", () => {
    const ref = createRef<HTMLMediaElement>();
    const { container } = render(
      <AssetMediaView asset={vid()} onTimeUpdate={() => {}} mediaRef={ref} />,
    );
    const video = container.querySelector("video");
    expect(video).toBeTruthy();
    expect(video!.hasAttribute("controls")).toBe(true);
    expect(ref.current).toBe(video);
  });

  it("renders an image for image files", () => {
    const file: FileRecord = { ...vid(), type: "image", contentType: "image/png", filename: "a.png" };
    const ref = createRef<HTMLMediaElement>();
    const { container } = render(
      <AssetMediaView asset={file} onTimeUpdate={() => {}} mediaRef={ref} />,
    );
    expect(container.querySelector("img")).toBeTruthy();
  });

  it("renders the audio player card with a full-width player on mediaRef", () => {
    const file: FileRecord = {
      ...vid(),
      type: "audio",
      contentType: "audio/mpeg",
      filename: "tone.mp3",
      name: "tone.mp3",
      size: 193141,
      mediaDuration: 12,
      mediaWidth: null,
      mediaHeight: null,
    };
    const ref = createRef<HTMLMediaElement>();
    const { container, getByText } = render(
      <AssetMediaView asset={file} onTimeUpdate={() => {}} mediaRef={ref} />,
    );
    const audio = container.querySelector("audio");
    expect(audio).toBeTruthy();
    expect(audio!.hasAttribute("controls")).toBe(true);
    // The transport must span the card (the old layout collapsed it to its
    // ~48px intrinsic minimum inside a shrink-to-fit wrapper).
    expect(audio!.className).toContain("w-full");
    const card = audio!.closest("div.max-w-xl");
    expect(card).toBeTruthy();
    expect(card!.className).toContain("w-full");
    // Metadata: name + format/size/duration line.
    getByText("tone.mp3");
    getByText("MP3 · 188.6 KB · 0:12");
    // Click-to-seek from transcript/summary works because the audio element
    // is registered on the shared media ref.
    expect(ref.current).toBe(audio);
  });
});
