// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

const { warning } = vi.hoisted(() => ({ warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning } }));

import {
  useRemovedTranscriptsNotice,
  removedTranscriptsNoticeText,
  resetRemovedTranscriptsNoticeForTests,
} from "@/hooks/editor/use-removed-transcripts-notice";

/**
 * A transcript the boot re-time removed (a FLAC-in-MP4 cut whose old decode
 * was garbled; review round 5, M7) is told ONCE, on the piece's next open:
 * GET …/composition reports it, the hook shows it and acknowledges it with a
 * POST, after which the server stops reporting it.
 */
describe("useRemovedTranscriptsNotice", () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true })));
  beforeEach(() => {
    warning.mockClear();
    fetchMock.mockClear();
    resetRemovedTranscriptsNoticeForTests();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("names the file, once, and acknowledges it on the server", () => {
    const removed = [{ fileId: "f1", name: "Interview take 3" }];
    const { rerender } = renderHook(({ list }) => useRemovedTranscriptsNotice("p1", list), { initialProps: { list: removed as typeof removed | undefined } });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0]).toBe(removedTranscriptsNoticeText(removed));
    expect(warning.mock.calls[0][0]).toMatch(/"Interview take 3"/);
    expect(warning.mock.calls[0][0]).toMatch(/transcribe it again/);
    expect(fetchMock).toHaveBeenCalledWith("/api/pieces/p1/composition/removed-transcripts-notice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileIds: ["f1"] }),
    });
    rerender({ list: removed }); // a refetch before the ack landed
    rerender({ list: [] }); // and after
    expect(warning).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("several files in one notice", () => {
    renderHook(() => useRemovedTranscriptsNotice("p1", [{ fileId: "a", name: "A" }, { fileId: "b", name: "B" }]));
    expect(warning.mock.calls[0][0]).toMatch(/transcripts of "A" and "B" were removed/);
  });

  it("says nothing for none, an unknown list, or no piece", () => {
    renderHook(() => useRemovedTranscriptsNotice("p1", []));
    renderHook(() => useRemovedTranscriptsNotice("p1", undefined));
    renderHook(() => useRemovedTranscriptsNotice(null, [{ fileId: "a", name: "A" }]));
    expect(warning).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
