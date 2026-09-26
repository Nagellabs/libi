import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { socialUploadRunner } from "@/lib/jobs/runners/social-upload";
import { withAdapter } from "@/lib/social/service";
import { SocialError } from "@/lib/social/errors";

vi.mock("@/lib/social/fit-check", async (orig) => ({ ...(await orig<object>()), isAllowedExportPath: () => true }));
// A `vi.fn()` rather than a fixed implementation so a single test (presign
// refusal) can override it with `mockImplementationOnce` without disturbing
// every other test's happy-path presign.
vi.mock("@/lib/social/service", () => ({ withAdapter: vi.fn() }));
const mockWithAdapter = vi.mocked(withAdapter);
const okPresign = async (fn: (a: unknown) => unknown) =>
  fn({ presign: async () => ({ uploadUrl: process.env.TEST_PUT_URL, publicUrl: "https://cdn.test/x.mp4", expiresAt: "2026-09-27T00:00:00Z" }) });

beforeEach(() => {
  mockWithAdapter.mockReset();
  mockWithAdapter.mockImplementation(okPresign as never);
});

let server: http.Server | undefined;
afterEach(() => server?.close());

describe("social-upload runner", () => {
  it("PUTs the file bytes with no Authorization header, reports progress, returns the public URL", async () => {
    const received: Buffer[] = [];
    let auth: string | undefined;
    server = http.createServer((req, res) => {
      auth = req.headers.authorization;
      req.on("data", (c) => received.push(c));
      req.on("end", () => {
        res.statusCode = 200;
        res.end();
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    process.env.TEST_PUT_URL = `http://127.0.0.1:${port}/upload`;
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "su-")), "export.mp4");
    fs.writeFileSync(file, Buffer.alloc(3 * 1024 * 1024, 1));
    const progress: number[] = [];
    const result = await socialUploadRunner.run({
      jobId: "j",
      params: { providerId: "zernio", exportPath: file, pieceId: "p" },
      resumeState: null,
      reportProgress: (d: number) => progress.push(d),
      checkpoint: async () => {},
      shouldCancel: () => false,
    } as never);
    expect(Buffer.concat(received).length).toBe(3 * 1024 * 1024);
    expect(auth).toBeUndefined();
    expect(result).toMatchObject({ publicUrl: "https://cdn.test/x.mp4", sizeBytes: 3 * 1024 * 1024, contentType: "video/mp4", filename: "export.mp4" });
    expect(progress.at(-1)).toBe(3 * 1024 * 1024);
    // Proves progress is reported DURING the upload, not only at the start
    // and the end: a 3 MB file streamed in 1 MB chunks must tick through at
    // least one value strictly between "nothing sent" and "all sent". A test
    // that only checked the last value stayed green even after the per-chunk
    // `ctx.reportProgress` call inside the "data" handler was deleted, since
    // the explicit final `reportProgress(sizeBytes, sizeBytes, ...)` call
    // still fired on its own.
    expect(progress.length).toBeGreaterThan(2);
    expect(progress.some((d) => d > 0 && d < 3 * 1024 * 1024)).toBe(true);
  });

  /**
   * Dedupe is by the FILE, not merely its path. `fileFingerprint` is the
   * export's size + mtime (`exportFingerprint`), which is stable for a stable
   * file — the opposite of a transient value, and the only reason "the same
   * export" and "a re-export to the same path" can be told apart. Nothing
   * else may join it: a toolCallId, a sessionId or a `Date.now()` here would
   * defeat dedupe and re-upload on every call, which is what put three
   * undeletable media objects in the user's account (QA 2026-09-21).
   */
  it("params identify the file and nothing transient", () => {
    const parsed = socialUploadRunner.paramsSchema.parse({
      providerId: "zernio",
      exportPath: "/e.mp4",
      pieceId: "p",
      fileFingerprint: "1234-9999",
    });
    expect(Object.keys(parsed).sort()).toEqual(["exportPath", "fileFingerprint", "pieceId", "providerId"]);
    // Required, so no caller can silently opt back out of file identity.
    expect(() => socialUploadRunner.paramsSchema.parse({ providerId: "zernio", exportPath: "/e.mp4", pieceId: "p" })).toThrow();
  });

  it("cancellation actually stops the provider from receiving the rest of the file — not just a local flag", async () => {
    let serverBytes = 0;
    let serverSawEnd = false;
    server = http.createServer((req, res) => {
      req.on("data", (c: Buffer) => { serverBytes += c.length; });
      req.on("end", () => {
        serverSawEnd = true;
        res.statusCode = 200;
        res.end();
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    process.env.TEST_PUT_URL = `http://127.0.0.1:${port}/upload`;
    // Large enough (relative to the 1 MB highWaterMark) that cancelling after
    // a couple of chunks leaves most of the file unsent — if the PUT kept
    // running underneath the "cancelled" throw, the provider would still end
    // up with all of it.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "su-cancel-")), "export.mp4");
    const sizeBytes = 20 * 1024 * 1024;
    fs.writeFileSync(file, Buffer.alloc(sizeBytes, 1));
    let shouldCancelCalls = 0;
    const run = socialUploadRunner.run({
      jobId: "j-cancel",
      params: { providerId: "zernio", exportPath: file, pieceId: "p" },
      resumeState: null,
      reportProgress: () => {},
      checkpoint: async () => {},
      // Flips true after a couple of chunks have already been read — the
      // "data" handler's own shouldCancel() check is what should catch this,
      // not a hypothetical caller wait for the whole file to finish.
      shouldCancel: () => { shouldCancelCalls += 1; return shouldCancelCalls > 2; },
    } as never);
    await expect(run).rejects.toThrow("cancelled");
    // Give the aborted socket a beat to be observed on the server side.
    await new Promise((r) => setTimeout(r, 150));
    expect(serverSawEnd).toBe(false);
    expect(serverBytes).toBeLessThan(sizeBytes);
  });

  it("distinguishes a presign refusal from a mid-PUT failure, preserving the provider's message", async () => {
    // Presign refusal: withAdapter itself rejects, before any byte is sent.
    // The runner must not repackage this as a generic upload failure — the
    // kind and message the adapter/service produced have to survive.
    mockWithAdapter.mockImplementationOnce(async () => {
      throw new SocialError("unauthorized", "the provider no longer accepts libi's sign-in", { status: 401 });
    });
    const file1 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "su-presign-")), "export.mp4");
    fs.writeFileSync(file1, Buffer.alloc(1024, 1));
    const presignErr = await socialUploadRunner
      .run({
        jobId: "j-presign",
        params: { providerId: "zernio", exportPath: file1, pieceId: "p" },
        resumeState: null,
        reportProgress: () => {},
        checkpoint: async () => {},
        shouldCancel: () => false,
      } as never)
      .then(
        () => null,
        (e: unknown) => e as SocialError,
      );
    expect(presignErr).toBeInstanceOf(SocialError);
    expect(presignErr?.kind).toBe("unauthorized");
    expect(presignErr?.message).toBe("the provider no longer accepts libi's sign-in");

    // Mid-PUT failure: presign succeeds (the default mock), but storage
    // rejects the bytes. This must be a DIFFERENT kind from the presign
    // refusal above, and the provider's own status text must survive.
    server = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.statusCode = 503;
        res.end("storage is temporarily unavailable");
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    process.env.TEST_PUT_URL = `http://127.0.0.1:${port}/upload`;
    const file2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "su-putfail-")), "export.mp4");
    fs.writeFileSync(file2, Buffer.alloc(1024, 1));
    const uploadErr = await socialUploadRunner
      .run({
        jobId: "j-putfail",
        params: { providerId: "zernio", exportPath: file2, pieceId: "p" },
        resumeState: null,
        reportProgress: () => {},
        checkpoint: async () => {},
        shouldCancel: () => false,
      } as never)
      .then(
        () => null,
        (e: unknown) => e as SocialError,
      );
    expect(uploadErr).toBeInstanceOf(SocialError);
    expect(uploadErr?.kind).toBe("provider");
    expect(uploadErr?.kind).not.toBe(presignErr?.kind);
    expect(uploadErr?.message).toContain("503");
  });
});
