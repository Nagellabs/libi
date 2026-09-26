/**
 * serveFileWithRange — HTTP Range request handling for media routes.
 *
 * The load-bearing behavior: video scrubbing in the editor fails silently
 * without `Accept-Ranges: bytes` + `206 Partial Content` responses, so we
 * pin both the headers and the byte-range parser.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseByteRange, serveFileWithRange } from "@/lib/http/range";

describe("parseByteRange", () => {
  it("parses bytes=0-499", () => {
    expect(parseByteRange("bytes=0-499", 1000)).toEqual({ start: 0, end: 499 });
  });

  it("parses bytes=500- as start-to-end", () => {
    expect(parseByteRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
  });

  it("parses bytes=-500 as suffix", () => {
    expect(parseByteRange("bytes=-500", 1000)).toEqual({ start: 500, end: 999 });
  });

  it("clamps end to totalSize - 1", () => {
    expect(parseByteRange("bytes=0-9999", 1000)).toEqual({ start: 0, end: 999 });
  });

  it("rejects malformed", () => {
    expect(parseByteRange("bytes=abc", 1000)).toBeNull();
    expect(parseByteRange("bytes=-", 1000)).toBeNull();
    expect(parseByteRange("items=0-10", 1000)).toBeNull();
  });

  it("rejects start beyond file", () => {
    expect(parseByteRange("bytes=5000-", 1000)).toBeNull();
  });

  it("rejects end < start", () => {
    expect(parseByteRange("bytes=500-100", 1000)).toBeNull();
  });
});

describe("serveFileWithRange", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "libi-range-test-"));
    filePath = join(dir, "data.bin");
    // Predictable bytes 0..99.
    const buf = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
    writeFileSync(filePath, buf);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 200 + Accept-Ranges header on a plain GET", async () => {
    const req = new Request("http://x/file");
    const res = serveFileWithRange({
      filePath,
      contentType: "application/octet-stream",
      request: req,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("100");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(100);
    expect(body[0]).toBe(0);
    expect(body[99]).toBe(99);
  });

  it("returns 206 + Content-Range for a byte range request", async () => {
    const req = new Request("http://x/file", { headers: { Range: "bytes=10-19" } });
    const res = serveFileWithRange({
      filePath,
      contentType: "video/mp4",
      request: req,
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(res.headers.get("content-length")).toBe("10");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(10);
    expect(body[0]).toBe(10);
    expect(body[9]).toBe(19);
  });

  it("honors open-ended ranges", async () => {
    const req = new Request("http://x/file", { headers: { Range: "bytes=95-" } });
    const res = serveFileWithRange({
      filePath,
      contentType: "video/mp4",
      request: req,
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 95-99/100");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body[0]).toBe(95);
    expect(body[4]).toBe(99);
  });

  it("returns 416 for an unsatisfiable range", () => {
    const req = new Request("http://x/file", { headers: { Range: "bytes=500-600" } });
    const res = serveFileWithRange({
      filePath,
      contentType: "video/mp4",
      request: req,
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */100");
  });

  it("returns 304 when If-None-Match matches the etag", () => {
    const req = new Request("http://x/file", { headers: { "If-None-Match": '"abc"' } });
    const res = serveFileWithRange({
      filePath,
      contentType: "video/mp4",
      etag: '"abc"',
      request: req,
    });
    expect(res.status).toBe(304);
  });

  // A directory stats fine but cannot be read: it used to go out as a 200 whose
  // stream then failed. Before the ETag short-circuit, too — a 304 for a folder
  // would say "your cached copy is still good" about something that is not a file.
  it("answers 404 for a directory, with the caller's headers, and never a 304", async () => {
    const res = serveFileWithRange({
      filePath: dir,
      contentType: "video/mp4",
      etag: '"abc"',
      request: new Request("http://x/file", { headers: { "If-None-Match": '"abc"', Range: "bytes=0-9" } }),
      extraHeaders: { "X-Content-Type-Options": "nosniff" },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("accept-ranges")).toBeNull();
    expect(await res.text()).toBe("Not found");
  });

  it("does not throw on client cancel mid-stream", async () => {
    // Regression: a client disconnect while bytes are still queued used to
    // raise an unhandled `Invalid state: Controller is already closed` from
    // the Web Streams adapter, which then killed the entire Next.js process
    // via process.on("uncaughtException"). nodeReadableToWebSafe should
    // swallow the post-close enqueue.
    const req = new Request("http://x/file");
    const res = serveFileWithRange({ filePath, contentType: "application/octet-stream", request: req });
    expect(res.body).not.toBeNull();
    const reader = res.body!.getReader();

    // Read one chunk, then cancel — simulating a browser closing the connection.
    await reader.read();
    await reader.cancel();

    // Give the underlying fs stream a tick to attempt any in-flight enqueue.
    // If our wrapper isn't catching post-close enqueues, this would surface
    // here as an unhandled rejection or a thrown error in the stream callback.
    let unhandled: Error | null = null;
    const onUnhandled = (err: unknown) => {
      unhandled = err instanceof Error ? err : new Error(String(err));
    };
    process.once("uncaughtException", onUnhandled);
    process.once("unhandledRejection", onUnhandled);
    await new Promise((r) => setTimeout(r, 50));
    process.off("uncaughtException", onUnhandled);
    process.off("unhandledRejection", onUnhandled);

    expect(unhandled).toBeNull();
  });
});
