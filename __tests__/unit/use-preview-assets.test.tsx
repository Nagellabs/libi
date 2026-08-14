// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePreviewAssets } from "@/hooks/editor/use-preview-assets";
import { createFrameStore } from "@/lib/preview/frame-store";

const fs = createFrameStore(0);

// Stub the three underlying hooks so we're only testing composition logic.
vi.mock("@/hooks/preview/use-video-sources", () => ({
  useVideoSources: (_c: unknown, _p: boolean) => ({
    sources: { sceneA: "v-source" },
    errors: { sceneA: { code: 4, message: "Unsupported codec" } },
  }),
}));
vi.mock("@/hooks/preview/use-overlay-images", () => ({
  useOverlayImages: () => ({ images: { overlayA: "i-elem" } }),
}));
vi.mock("@/hooks/preview/use-overlay-code", () => ({
  useOverlayCompiledFns: () => ({ compiledDrawFns: { overlayB: () => {} } }),
}));

describe("usePreviewAssets", () => {
  it("returns videoSources + images + compiledDrawFns bundled together", () => {
    const { result } = renderHook(() => usePreviewAssets(null, false, 1, fs));
    expect(result.current.videoSources).toEqual({ sceneA: "v-source" });
    expect(result.current.images).toEqual({ overlayA: "i-elem" });
    expect(typeof result.current.compiledDrawFns.overlayB).toBe("function");
  });

  it("forwards videoErrors from useVideoSources so callers can render warnings", () => {
    const { result } = renderHook(() => usePreviewAssets(null, false, 1, fs));
    expect(result.current.videoErrors).toEqual({
      sceneA: { code: 4, message: "Unsupported codec" },
    });
  });
});
