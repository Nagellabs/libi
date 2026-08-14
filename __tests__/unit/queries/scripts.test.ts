// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AnalysisBundle, AnalysisStep } from "@/lib/analysis/types";
import type { JobStatusSnapshot } from "@/lib/jobs/types";

function makeStep(overrides: Partial<AnalysisStep>): AnalysisStep {
  return {
    id: overrides.id ?? "s",
    fileId: "file-1",
    pieceId: null,
    kind: overrides.kind ?? "summary",
    status: "ready",
    content: overrides.content ?? null,
    metadata: null,
    errorMessage: null,
    sourceModifiedAt: null,
    createdAt: overrides.createdAt ?? new Date(0),
    updatedAt: overrides.createdAt ?? new Date(0),
  } as AnalysisStep;
}

const scriptContent = JSON.stringify({
  schema_version: "script_v1",
  duration: 5,
  overall_style: "test",
  shots: [{ index: 0, start: 0, end: 5, description: "shot" }],
  music: { present: false },
  provider: {
    name: "fal-video-understanding",
    model: "gemini-2.5-pro",
    generatedAt: "2026-05-20T00:00:00Z",
  },
});

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

function wrap() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
  Wrapper.displayName = "QueryClientWrapper";
  return Wrapper;
}

describe("useLatestScript", () => {
  it("returns the newest PersistedScript when multiple script rows exist", async () => {
    const bundle: AnalysisBundle = {
      steps: [
        makeStep({
          id: "old",
          kind: "script:fal-video-understanding:gemini-2.5-pro",
          content: scriptContent,
          createdAt: new Date("2026-05-20T00:00:00Z"),
        }),
        makeStep({
          id: "new",
          kind: "script:fal-video-understanding:gemini-2.5-flash",
          content: scriptContent,
          createdAt: new Date("2026-05-25T00:00:00Z"),
        }),
      ],
      keyframes: [],
      audioChunks: [],
      staleKeyframeIds: [],
    } as unknown as AnalysisBundle;

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(bundle), { status: 200 }),
    );

    const { useLatestScript } = await import("@/lib/queries/scripts");
    const { result } = renderHook(() => useLatestScript("file-1"), { wrapper: wrap() });

    await vi.waitFor(() => expect(result.current.data).toBeTruthy());
    expect(result.current.data?.step.id).toBe("new");
    expect(result.current.data?.modelId).toBe("gemini-2.5-flash");
  });

  it("returns undefined when there are no script rows", async () => {
    const bundle: AnalysisBundle = {
      steps: [makeStep({ kind: "summary", content: "{}" })],
      keyframes: [],
      audioChunks: [],
      staleKeyframeIds: [],
    } as unknown as AnalysisBundle;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(bundle), { status: 200 }),
    );

    const { useLatestScript } = await import("@/lib/queries/scripts");
    const { result } = renderHook(() => useLatestScript("file-1"), { wrapper: wrap() });

    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});

describe("useScriptJob", () => {
  it("returns the latest extra_analysis_model job for this fileId", async () => {
    const a: JobStatusSnapshot = {
      id: "j1", kind: "extra_analysis_model", status: "running",
      pieceId: "p", fileId: "file-1",
      progressDone: 0, progressTotal: 0, progressUnit: "items",
      etaMs: null, msPerUnit: null, error: null, resultJson: null,
      startedAt: new Date("2026-05-25T00:00:00Z"),
      completedAt: null, lastProgressAt: null,
    };
    const b: JobStatusSnapshot = {
      ...a, id: "j2",
      startedAt: new Date("2026-05-26T00:00:00Z"),
    };
    const otherFile: JobStatusSnapshot = {
      ...a, id: "j3", fileId: "other-file",
      startedAt: new Date("2026-05-27T00:00:00Z"),
    };

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ jobs: [a, b, otherFile] }), { status: 200 }),
    );

    const { useScriptJob } = await import("@/lib/queries/scripts");
    const { result } = renderHook(() => useScriptJob("file-1"), { wrapper: wrap() });

    await vi.waitFor(() => expect(result.current.data).toBeTruthy());
    expect(result.current.data?.id).toBe("j2"); // newer of the two for file-1
  });
});
