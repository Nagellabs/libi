// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useFilmstripStatus,
  useFilmstripStatuses,
  filmstripUrl,
  type FilmstripStatus,
} from "@/lib/queries/filmstrips";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

function jsonRes(body: FilmstripStatus) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function wrap() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
  Wrapper.displayName = "QueryClientWrapper";
  return Wrapper;
}

describe("filmstripUrl", () => {
  it("points at the by-id filmstrip serve route", () => {
    expect(filmstripUrl("abc")).toBe("/api/files/by-id/abc/filmstrip");
  });
});

describe("useFilmstripStatus", () => {
  it("fetches with ensure=1 and surfaces the status", async () => {
    fetchMock.mockResolvedValue(
      jsonRes({
        status: "ready",
        filename: "x-filmstrip.jpg",
        frames: 20,
        height: 48,
        generatedAt: "2026-06-20T10:00:00.000Z",
      }),
    );

    const { result } = renderHook(() => useFilmstripStatus("f1"), {
      wrapper: wrap(),
    });

    await waitFor(() => expect(result.current.data?.status).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/files/by-id/f1/filmstrip-status?ensure=1",
    );
    expect(result.current.data?.frames).toBe(20);
  });

  it("is disabled (no fetch) when fileId is null", async () => {
    const { result } = renderHook(() => useFilmstripStatus(null), {
      wrapper: wrap(),
    });
    // No fetch fires for a disabled query.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });
});

describe("useFilmstripStatuses (batched)", () => {
  it("returns a Map keyed by fileId with each status", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const ready = url.includes("/f-ready/");
      return jsonRes({
        status: ready ? "ready" : "generating",
        filename: ready ? "r-filmstrip.jpg" : null,
        frames: ready ? 20 : null,
        height: ready ? 48 : null,
        generatedAt: null,
      });
    });

    const { result } = renderHook(
      () => useFilmstripStatuses(["f-ready", "f-gen"]),
      { wrapper: wrap() },
    );

    await waitFor(() =>
      expect(result.current.get("f-ready")?.status).toBe("ready"),
    );
    expect(result.current.get("f-gen")?.status).toBe("generating");
  });

  it("dedups repeated fileIds", async () => {
    fetchMock.mockResolvedValue(
      jsonRes({
        status: "ready",
        filename: "x.jpg",
        frames: 20,
        height: 48,
        generatedAt: null,
      }),
    );
    const { result } = renderHook(
      () => useFilmstripStatuses(["dup", "dup", "dup"]),
      { wrapper: wrap() },
    );
    await waitFor(() => expect(result.current.get("dup")?.status).toBe("ready"));
    // One distinct fileId → exactly one fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
