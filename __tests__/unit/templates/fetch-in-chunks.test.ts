import { describe, expect, it, vi } from "vitest";
import { fetchInChunks, type BatchPosition, type FetchedUrl } from "@/lib/templates/fetch-in-chunks";

type RunOne = (urls: string[], filenames: Record<string, string> | undefined, position: BatchPosition) => Promise<FetchedUrl[]>;
import { REMOTE_FETCH_MAX_URLS } from "@/lib/net/fetch-and-store";

describe("fetchInChunks", () => {
  it("splits 42 urls into jobs of at most 20, in order, and names each url's file in its own chunk", async () => {
    const urls = Array.from({ length: 42 }, (_, i) => `https://h.example/${i}.png`);
    const filenames = { [urls[0]]: "template-asset-1.png", [urls[41]]: "template-asset-42.png" };
    const runOne = vi.fn<RunOne>(async (chunk) => chunk.map((url) => ({ url, fileId: `f-${url}` })));
    const out = await fetchInChunks(urls, filenames, runOne);
    expect(runOne.mock.calls.map((c) => c[0].length)).toEqual([20, 20, 2]);
    expect(runOne.mock.calls.every((c) => c[0].length <= REMOTE_FETCH_MAX_URLS)).toBe(true);
    expect(runOne.mock.calls[0][1]).toEqual({ [urls[0]]: "template-asset-1.png" });
    // A chunk none of whose urls is named gets no names at all, as a single call did.
    expect(runOne.mock.calls[1][1]).toBeUndefined();
    expect(runOne.mock.calls[2][1]).toEqual({ [urls[41]]: "template-asset-42.png" });
    expect(out.map((r) => r.url)).toEqual(urls);
    // Each batch is told where it sits, so its progress can be offset (T8 fix round 2).
    expect(runOne.mock.calls.map((c) => c[2])).toEqual([{ offset: 0, total: 42 }, { offset: 20, total: 42 }, { offset: 40, total: 42 }]);
  });

  it("runs the chunks one after another, never two at once", async () => {
    const urls = Array.from({ length: 45 }, (_, i) => `https://h.example/${i}.png`);
    let running = 0;
    let peak = 0;
    const runOne = vi.fn(async (chunk: string[]) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return chunk.map((url) => ({ url, fileId: "x" }));
    });
    await fetchInChunks(urls, undefined, runOne);
    expect(runOne).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
  });

  it("20 or fewer urls run exactly one call with the names unchanged", async () => {
    const urls = Array.from({ length: 20 }, (_, i) => `https://h.example/${i}.png`);
    const filenames = { [urls[3]]: "template-asset-4.png" };
    const runOne = vi.fn<RunOne>(async (chunk) => chunk.map((url) => ({ url, fileId: "x" })));
    await fetchInChunks(urls, filenames, runOne);
    expect(runOne).toHaveBeenCalledTimes(1);
    expect(runOne.mock.calls[0]).toEqual([urls, filenames, { offset: 0, total: 20 }]);
  });

  it("a chunk that throws (job failed, server unreachable) rejects the whole fetch and no later chunk starts", async () => {
    const urls = Array.from({ length: 45 }, (_, i) => `https://h.example/${i}.png`);
    const boom = new Error("remote_fetch failed");
    const runOne = vi
      .fn<RunOne>()
      .mockImplementationOnce(async (c) => c.map((url) => ({ url, fileId: "x" })))
      .mockRejectedValueOnce(boom);
    await expect(fetchInChunks(urls, undefined, runOne)).rejects.toBe(boom);
    expect(runOne).toHaveBeenCalledTimes(2);
  });

  it("the chat's Stop (CancelledError) in chunk 1 rejects, and runOne is called once", async () => {
    const urls = Array.from({ length: 42 }, (_, i) => `https://h.example/${i}.png`);
    const stop = Object.assign(new Error("job cancelled"), { name: "CancelledError" });
    const runOne = vi.fn<RunOne>().mockRejectedValueOnce(stop);
    await expect(fetchInChunks(urls, undefined, runOne)).rejects.toBe(stop);
    expect(runOne).toHaveBeenCalledTimes(1);
  });

  it("a client abort (AbortError) propagates and no later chunk starts", async () => {
    const urls = Array.from({ length: 45 }, (_, i) => `https://h.example/${i}.png`);
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const runOne = vi
      .fn<RunOne>()
      .mockImplementationOnce(async (c) => c.map((url) => ({ url, fileId: "x" })))
      .mockRejectedValueOnce(abort);
    await expect(fetchInChunks(urls, undefined, runOne)).rejects.toBe(abort);
    expect(runOne).toHaveBeenCalledTimes(2);
  });

  it("per-url failures inside a job are results, not throws: every chunk runs", async () => {
    const urls = Array.from({ length: 25 }, (_, i) => `https://h.example/${i}.png`);
    const runOne = vi.fn<RunOne>(async (c) => c.map((url, i) => (i === 0 ? { url, error: "404" } : { url, fileId: "x" })));
    const out = await fetchInChunks(urls, undefined, runOne);
    expect(runOne).toHaveBeenCalledTimes(2);
    expect(out.filter((r) => r.error === "404").map((r) => r.url)).toEqual([urls[0], urls[20]]);
  });
});
