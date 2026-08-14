import { describe, it, expect, vi, afterEach } from "vitest";
import { Writable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// `streamResponseToFileWithCap` grabs `createWriteStream` via a dynamic
// `await import("node:fs")` inside the function body — `vi.mock` intercepts
// module resolution itself (unlike `vi.spyOn` on an already-bound `fs`
// import, which doesn't reliably reach a separately-resolved dynamic
// import under Vitest's ESM handling), so it's the reliable way to swap in
// a controlled writable for the backpressure test below. Defaults to the
// REAL `createWriteStream` so the cap-trip test (which doesn't care about
// backpressure) still writes to a real temp file untouched. `vi.hoisted`
// because `vi.mock`'s factory is hoisted above ordinary top-level `const`s.
const { createWriteStreamMock, setRealCreateWriteStream } = vi.hoisted(() => {
  let real: ((...args: unknown[]) => unknown) | null = null;
  const mock = vi.fn((...args: unknown[]) => {
    if (!real) throw new Error("real createWriteStream not captured yet");
    return real(...args);
  });
  return {
    createWriteStreamMock: mock,
    setRealCreateWriteStream: (fn: (...args: unknown[]) => unknown) => {
      real = fn;
    },
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  setRealCreateWriteStream(actual.createWriteStream as (...args: unknown[]) => unknown);
  const patched = (...args: unknown[]) => createWriteStreamMock(...args);
  return { ...actual, default: { ...actual.default, createWriteStream: patched }, createWriteStream: patched };
});

import { streamResponseToFileWithCap } from "@/lib/jobs/runners/tracking";

/**
 * The existing coverage for the http-to-tempfile download (in
 * tracking-runner.test.ts) only ever exercises a single 5-byte chunk, so it
 * never exercises the backpressure path (`if (!out.write(...)) await
 * once(out, "drain")`) or the byte-cap-trip path. A truncated video still
 * PRODUCES tracking output — just wrong output — so silent truncation here
 * is the dangerous failure mode, not a loud one.
 */

/** Build a Response whose body streams `count` chunks of `chunkSize` bytes,
 * each filled with an incrementing byte pattern so a truncated/reordered
 * output is detectable, not just a wrong total length. */
function manyChunkResponse(count: number, chunkSize: number): { res: Response; expected: Buffer } {
  const parts: Buffer[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < count; i++) {
        const chunk = Buffer.alloc(chunkSize, i % 256);
        parts.push(chunk);
        controller.enqueue(new Uint8Array(chunk));
      }
      controller.close();
    },
  });
  return { res: new Response(stream, { status: 200 }), expected: Buffer.concat(parts) };
}

describe("streamResponseToFileWithCap", () => {
  let tmpDir: string;

  afterEach(() => {
    createWriteStreamMock.mockClear();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes ~50k chunks through a stalling writable byte-exact — proves no silent truncation/reordering under backpressure", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-track-stream-"));
    const destPath = path.join(tmpDir, "video.mp4");

    const CHUNKS = 50_000;
    const CHUNK_SIZE = 16;
    const { res, expected } = manyChunkResponse(CHUNKS, CHUNK_SIZE);

    // A deliberately "stalling" writable: a tiny highWaterMark plus an
    // ALWAYS-deferred (setImmediate) write callback means the internal
    // buffer routinely exceeds the watermark, so `out.write()` keeps
    // returning false and the function under test must actually wait on
    // `once(out, "drain")` rather than racing ahead of a slow consumer.
    const written: Buffer[] = [];
    const stalling = new Writable({
      highWaterMark: 64,
      write(chunk, _enc, callback) {
        written.push(Buffer.from(chunk));
        setImmediate(callback);
      },
    });
    createWriteStreamMock.mockReturnValueOnce(stalling);

    const bytes = await streamResponseToFileWithCap(
      res,
      destPath,
      expected.byteLength + 1, // cap comfortably above the real size
    );

    expect(bytes).toBe(expected.byteLength);
    const actual = Buffer.concat(written);
    expect(actual.byteLength).toBe(expected.byteLength);
    expect(actual.equals(expected)).toBe(true);
  }, 20_000);

  it("trips the byte cap partway through and cancels the underlying stream instead of reading it to completion", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-track-cap-"));
    const destPath = path.join(tmpDir, "video.mp4");

    let canceled = false;
    let cancelReason: unknown;
    const CHUNK_SIZE = 1024;
    const TOTAL_CHUNKS = 64; // 64 KB total — comfortably over the cap below
    const MAX_BYTES = 5_000; // trips partway through the stream

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < TOTAL_CHUNKS; i++) {
          controller.enqueue(new Uint8Array(CHUNK_SIZE));
        }
        controller.close();
      },
      cancel(reason) {
        canceled = true;
        cancelReason = reason;
      },
    });
    const res = new Response(stream, { status: 200 });

    await expect(
      streamResponseToFileWithCap(res, destPath, MAX_BYTES),
    ).rejects.toThrow(/video too large/);

    // The cap breach must abort the in-flight download by canceling the
    // stream — not merely stop reading and let it drain in the background.
    expect(canceled).toBe(true);
    expect(cancelReason).toBeUndefined();
  });
});
