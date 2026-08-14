/**
 * @vitest-environment jsdom
 *
 * The chat-message file attachment chip:
 *   - shows an image thumbnail for images
 *   - shows a video poster + play overlay for videos
 *   - shows an audio glyph for audio
 *   - falls back to a "not in resources" badge when the file no longer
 *     exists (deleted from resources after the chat message was sent)
 *   - calls `onOpen` with the live FileRecord on click — this is what
 *     drives the editor's switch-piece-then-show-asset flow.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import FileAttachmentChip from "@/components/chat/file-attachment-chip";
import type { FileRecord } from "@/lib/db/schema/types";

const mockFetch = vi.fn();
beforeEach(() => {
  mockFetch.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

function makeFile(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: "file-1",
    pieceId: "piece-1",
    filename: "asset.bin",
    name: "asset.bin",
    description: "",
    type: "other",
    storagePath: "piece-1/asset.bin",
    contentType: null,
    size: 100,
    mediaDuration: null,
    mediaWidth: null,
    mediaHeight: null,
    hasAudio: false,
    proxyFilename: null,
    proxyStatus: "idle",
    proxyGeneratedAt: null,
    createdAt: new Date(),
    ...overrides,
  } as FileRecord;
}

function renderChip(props: Parameters<typeof FileAttachmentChip>[0]) {
  // Disable retries so 404 fallbacks resolve instantly in the test.
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <FileAttachmentChip {...props} />
    </QueryClientProvider>,
  );
}

function mockFileLookup(file: FileRecord | null) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("/api/files/by-id/")) {
      if (!file) {
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ file }),
      } as Response;
    }
    return { ok: false, status: 500, json: async () => ({}) } as Response;
  });
}

describe("FileAttachmentChip", () => {
  it("renders an image thumbnail for image files", async () => {
    mockFileLookup(
      makeFile({
        id: "img1",
        contentType: "image/png",
        type: "image",
        filename: "shot.png",
        name: "shot.png",
      }),
    );
    renderChip({
      fileId: "img1",
      filename: "shot.png",
      contentType: "image/png",
      size: 2048,
    });

    const img = await screen.findByRole("img", { name: "shot.png" });
    expect(img).toBeInTheDocument();
    expect(img.getAttribute("src")).toBe("/api/files/by-id/img1/content");
  });

  it("renders a video element with poster overlay for video files", async () => {
    mockFileLookup(
      makeFile({
        id: "vid1",
        contentType: "video/mp4",
        type: "video",
        filename: "clip.mp4",
        name: "clip.mp4",
      }),
    );
    const { container } = renderChip({
      fileId: "vid1",
      filename: "clip.mp4",
      contentType: "video/mp4",
      size: 1024 * 1024,
    });

    // The lookup is async — wait until the video element appears (the
    // chip renders a placeholder div first while react-query is loading).
    const video = await waitFor(() => {
      const v = container.querySelector("video");
      if (!v) throw new Error("video not yet rendered");
      return v;
    });
    expect(video.getAttribute("src")).toBe("/api/files/by-id/vid1/content");
  });

  it("renders an audio glyph for audio files (no media element)", async () => {
    mockFileLookup(
      makeFile({
        id: "aud1",
        contentType: "audio/mpeg",
        type: "audio",
        filename: "song.mp3",
        name: "song.mp3",
      }),
    );
    const { container } = renderChip({
      fileId: "aud1",
      filename: "song.mp3",
      contentType: "audio/mpeg",
      size: 4096,
    });

    await screen.findByText("song.mp3");
    expect(container.querySelector("audio")).toBeNull();
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("falls back to a 'not in resources' badge when the file is missing", async () => {
    mockFileLookup(null);
    renderChip({
      fileId: "gone",
      filename: "deleted.mp4",
      contentType: "video/mp4",
      size: 1234,
    });
    expect(await screen.findByText(/not in resources/i)).toBeInTheDocument();
    // Falls back to the snapshotted filename / size from the message part.
    expect(screen.getByText("deleted.mp4")).toBeInTheDocument();
  });

  it("calls onOpen with the live FileRecord when clicked", async () => {
    const file = makeFile({
      id: "vid1",
      pieceId: "piece-99",
      filename: "clip.mp4",
      name: "clip.mp4",
      contentType: "video/mp4",
      type: "video",
    });
    mockFileLookup(file);
    const onOpen = vi.fn();
    renderChip({
      fileId: "vid1",
      filename: "clip.mp4",
      contentType: "video/mp4",
      size: 100,
      onOpen,
    });

    // Wait until the chip becomes interactive (button only renders once
    // the file lookup resolves with an existing record AND onOpen is set).
    const button = await waitFor(() => {
      const el = screen.getByText("clip.mp4").closest("button");
      if (!el) throw new Error("not yet interactive");
      return el;
    });
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0]).toMatchObject({
      id: "vid1",
      pieceId: "piece-99",
    });
  });

  it("renders as a non-interactive div when the file is missing (no onOpen call)", async () => {
    mockFileLookup(null);
    const onOpen = vi.fn();
    renderChip({
      fileId: "gone",
      filename: "deleted.mp4",
      contentType: "video/mp4",
      size: 100,
      onOpen,
    });
    await screen.findByText(/not in resources/i);
    // The wrapper for missing files is a div, not a button — clicking
    // it must NOT fire onOpen.
    const text = screen.getByText("deleted.mp4");
    fireEvent.click(text);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
