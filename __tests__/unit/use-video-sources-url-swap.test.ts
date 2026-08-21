/**
 * Unit: useVideoSources replaces the per-scene video source when a scene's
 * videoUrl changes but its id stays the same. Covers the proxy-flip path
 * (idle → ready causes buildComposition to hand us a new URL for the same
 * scene.id).
 *
 * This is a unit test of the HOOK's source bookkeeping (attach / swap-on-url /
 * keep-when-unchanged), so MediaBunnyFrameSource is stubbed — no real WebCodecs
 * decoder, no network. (useEditorState is mocked too; the hook reads only
 * previewQuality and the full EditorStateProvider needs the Next app-router +
 * session-list contexts that don't exist in jsdom.)
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVideoSources } from "@/hooks/preview/use-video-sources";
import { createFrameStore } from "@/lib/preview/frame-store";

const fs = createFrameStore(0);
import type { Composition } from "@/lib/engine/types";

vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({ previewQuality: "auto" }),
}));

// Lightweight stand-in for the WebCodecs source: records its url, satisfies the
// VideoFrameSource surface the hook touches (onFrame / budget control / dispose).
vi.mock("@/lib/engine/media-bunny-frame-source", () => ({
  MediaBunnyFrameSource: class {
    constructor(
      public readonly url: string,
      public readonly maxDecodeHeight: number,
    ) {}
    setTelemetryLabel() {}
    onFrame() {
      return () => {};
    }
    play() {}
    pause() {}
    warm() {}
    seek() {}
    prime() {
      return Promise.resolve();
    }
    getFrame() {
      return null as unknown as CanvasImageSource;
    }
    isReadyAt() {
      return false;
    }
    bufferedThrough(t: number) {
      return t;
    }
    lastGoodFrame() {
      return null;
    }
    adoptLastGood() {}
    notePainted() {}
    dispose() {}
  },
}));

function mkComp(videoUrl: string): Composition {
  return {
    id: "c1",
    name: "Test",
    width: 320,
    height: 240,
    fps: 30,
    overlays: [
      {
        id: "scene-1",
        kind: "video",
        fileId: "f1",
        videoUrl,
        startTime: 0,
        duration: 2,
        z: 0,
        opacity: 1,
        fit: "cover",
        rect: { x: 0, y: 0, width: 320, height: 240 },
        trim: { start: 0, end: 2 },
      },
    ],
  };
}

describe("useVideoSources URL swap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a fresh source when videoUrl changes but the overlay id stays the same", () => {
    const { result, rerender } = renderHook(
      ({ comp }) => useVideoSources(comp, false, 1, fs),
      { initialProps: { comp: mkComp("/api/files/by-id/f1/content") } },
    );

    const originalSource = result.current.sources["scene-1"];
    expect(originalSource).toBeDefined();

    // Flip to proxy URL — same scene.id, different videoUrl.
    act(() => {
      rerender({ comp: mkComp("/api/files/by-id/f1/proxy") });
    });

    const swappedSource = result.current.sources["scene-1"];
    expect(swappedSource).toBeDefined();
    // Identity change is the load-bearing assertion: the old source
    // (pointing at /content) must be gone, replaced with one pointing
    // at /proxy.
    expect(swappedSource).not.toBe(originalSource);
    expect((swappedSource as unknown as { url: string }).url).toBe(
      "/api/files/by-id/f1/proxy",
    );
  });

  it("keeps the same source instance when nothing changes", () => {
    const comp = mkComp("/api/files/by-id/f1/content");
    const { result, rerender } = renderHook(
      ({ c }) => useVideoSources(c, false, 1, fs),
      { initialProps: { c: comp } },
    );
    const before = result.current.sources["scene-1"];
    act(() => {
      rerender({ c: comp });
    });
    expect(result.current.sources["scene-1"]).toBe(before);
  });

  // NOTE: first-frame-decode → snapshot-bump (initial paint / paused scrub) is
  // now driven by MediaBunnyFrameSource.onFrame after a real decode, which needs
  // a live decoder — verified by the Playwright preview harness, not jsdom.
});
