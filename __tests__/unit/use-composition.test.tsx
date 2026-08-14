// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { useComposition } from "@/hooks/editor/use-composition";

// Stub the underlying query hooks so we can test the composition+totalFrames
// derivation without running the real HTTP layer.
vi.mock("@/lib/queries/pieces", () => ({
  usePieceComposition: () => ({
    data: {
      manifest: {
        sceneOrder: ["s1"],
        width: 1920,
        height: 1080,
        fps: 30,
        overlays: [],
      },
      scenes: [
        { id: "s1", type: "canvas", name: "c", duration: 2, drawFunction: "ctx" },
      ],
      audioClips: [],
    },
    isLoading: false,
    isFetching: false,
  }),
  pieceKeys: { composition: () => ["composition"] },
}));
vi.mock("@/lib/queries/files", () => ({
  useFiles: () => ({ data: [], isLoading: false, isSuccess: true }),
  useGlobalFiles: () => ({ data: [], isLoading: false, isSuccess: true }),
  fileKeys: { forPiece: () => ["files"], global: () => ["files", "global"] },
}));
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({ viewMode: "draft" }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient();
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useComposition", () => {
  it("returns null composition when pieceId is null", () => {
    const { result } = renderHook(() => useComposition(null), { wrapper });
    expect(result.current.composition).toBeNull();
  });

  it("builds a composition with one scene and computes totalFrames", async () => {
    const { result } = renderHook(() => useComposition("p1"), { wrapper });
    await waitFor(() => expect(result.current.composition).not.toBeNull());
    expect(result.current.composition!.scenes).toHaveLength(1);
    expect(result.current.totalFrames).toBe(60); // 2 seconds × 30 fps
    expect(result.current.rawScenes).toHaveLength(1);
    expect(result.current.isFetching).toBe(false);
  });
});
