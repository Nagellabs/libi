import { describe, it, expect } from "vitest";
import { readBodyWithCap } from "@/lib/jobs/runners/remote-fetch";

/** Build a streaming Response whose body emits `chunks` of the given sizes. */
function streamingResponse(chunkSizes: number[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const n of chunkSizes) controller.enqueue(new Uint8Array(n));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe("readBodyWithCap", () => {
  it("returns the full buffer when under the cap", async () => {
    const buf = await readBodyWithCap(streamingResponse([100, 100, 50]), 1000);
    expect(buf.byteLength).toBe(250);
  });

  it("throws as soon as the running total exceeds the cap", async () => {
    // Cap of 150 with 100-byte chunks — should abort on the 2nd chunk (200 > 150)
    // rather than reading the whole 300-byte body.
    await expect(
      readBodyWithCap(streamingResponse([100, 100, 100]), 150),
    ).rejects.toThrow(/file too large/);
  });

  it("accepts a body exactly at the cap", async () => {
    const buf = await readBodyWithCap(streamingResponse([128, 128]), 256);
    expect(buf.byteLength).toBe(256);
  });

  it("falls back to arrayBuffer for a null-body response", async () => {
    const buf = await readBodyWithCap(new Response(null, { status: 204 }), 1000);
    expect(buf.byteLength).toBe(0);
  });
});
