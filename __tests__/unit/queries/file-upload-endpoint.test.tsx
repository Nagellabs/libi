// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The probe drives <img>/<video> load events that never fire in jsdom; it has
// its own behaviour and is not what these tests are about.
vi.mock("@/lib/utils/media-probe", () => ({
  probeMediaMetadata: async () => ({ width: 640, height: 480 }),
}));

import { uploadFileTo, useFileUpload } from "@/lib/queries/files";

const png = () => new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });

function ok(body: unknown = { file: { id: "f1" } }) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => ok());
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

describe("upload endpoint selection", () => {
  it("posts to the piece route when there is a piece", async () => {
    await uploadFileTo("p1", png());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/pieces/p1/upload");
  });

  it("posts to the global route when there is no piece", async () => {
    await uploadFileTo(null, png());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/upload");
  });

  it("treats an EMPTY pieceId as no piece", async () => {
    // The reported bug. The chat panel is handed `activePieceId ?? ""`, and an
    // empty id built "/api/pieces//upload" — which 308s to "/api/pieces/upload",
    // matching [pieceId]/route.ts with pieceId="upload", a route with no POST.
    // Every chat attachment sent with no piece open died on that 405.
    const { result } = renderHook(() => useFileUpload(""), { wrapper });
    await act(async () => {
      await result.current.upload(png());
    });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe("/api/upload");
    expect(url).not.toContain("//upload");
  });

  it("refreshes the GLOBAL file list after an upload with no piece", async () => {
    // Not cosmetic: invalidating ["files", ""] matches no query, so the newly
    // uploaded asset would not appear in Resources until something else forced
    // a refetch. Pins the hook's own normalization, which the URL assertion
    // above cannot see (uploadFileTo guards the URL independently).
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const spy = vi.spyOn(qc, "invalidateQueries");
    const w = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useFileUpload(""), { wrapper: w });
    await act(async () => {
      await result.current.upload(png());
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["files", "global"] });
  });

  it("sends the probed dimensions", async () => {
    await uploadFileTo("p1", png());
    const body = fetchMock.mock.calls[0][1].body as FormData;
    expect(body.get("mediaWidth")).toBe("640");
    expect(body.get("mediaHeight")).toBe("480");
  });
});

describe("upload failure messages", () => {
  it("surfaces the server's own error text", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: "disk is full" }),
    } as unknown as Response);
    await expect(uploadFileTo("p1", png())).rejects.toThrow("disk is full");
  });

  it("falls back to the status code when the body is not JSON", async () => {
    // Exactly the 405 case: a route mismatch answers with no JSON body, and a
    // bare "Upload failed" left nothing to diagnose from.
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 405,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);
    await expect(uploadFileTo("p1", png())).rejects.toThrow("405");
  });
});
