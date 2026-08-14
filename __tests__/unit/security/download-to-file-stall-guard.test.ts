/**
 * Follow-up to task #54, found during the dev-build E2E on 2026-08-02.
 *
 * #54 gave the DEPENDENCY-MANAGER download path an idle deadline + bounded
 * retries. The tracking-engine installer kept its own bare
 * `fetch(url, { redirect: "follow" })` — on the path that pulls by far the
 * LARGEST artifacts (a 572 MB MobileCLIP encoder, 141 MB MatAnyone weights).
 *
 * Observed for real on a clean install: the encoder download stalled mid-body,
 * undici's default body timeout fired as UND_ERR_BODY_TIMEOUT, and the whole
 * tracking provision died with an unhandled stack trace and no retry.
 *
 * Buffering is not an option at that size, so `downloadToFileWithStallGuard`
 * streams to disk and hashes as it writes, while sharing ONE retry loop with
 * the buffering helper (`runGuardedDownload`) so the two can never again
 * diverge in protection — which is the exact trap this bug came from.
 *
 * Load-bearing assertions:
 *   - a stalled stream fails on the IDLE deadline instead of hanging
 *   - a slow-but-PROGRESSING stream SUCCEEDS (idle deadline, not flat timeout)
 *   - a retry does NOT append to the previous attempt's bytes
 *   - nothing is left at the destination path on give-up
 *   - the sha256 is computed over the streamed bytes
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  downloadToFileWithStallGuard,
  DownloadFailedError,
} from "@/lib/security/download-verify";
import {
  startStallServer,
  type StallServer,
  OK_BODY,
  SLOW_CHUNK,
  SLOW_CHUNK_COUNT,
  SLOW_CHUNK_INTERVAL_MS,
} from "../../helpers/stall-server";

const viaPlainFetch = (url: string, init?: RequestInit) => fetch(url, init);

let server: StallServer;
let tmpDir: string;

beforeAll(async () => {
  server = await startStallServer();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-dl-file-"));
});

afterAll(async () => {
  await server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function dest(name: string): string {
  return path.join(tmpDir, name);
}

describe("downloadToFileWithStallGuard", () => {
  it("fails on the idle deadline instead of hanging, and leaves no dest file", async () => {
    const target = dest("stalled.bin");
    const started = Date.now();

    await expect(
      downloadToFileWithStallGuard(`${server.origin}/stall-mid-body`, target, {
        label: "mobileclip_blt.ts",
        idleTimeoutMs: 300,
        maxAttempts: 2,
        backoffMs: [10],
        doFetch: viaPlainFetch,
      }),
    ).rejects.toBeInstanceOf(DownloadFailedError);

    const elapsed = Date.now() - started;
    // 2 attempts * 300ms idle + 10ms backoff, with generous slack. The point
    // is BOUNDED — the production bug was unbounded.
    expect(elapsed).toBeLessThan(8_000);

    expect(fs.existsSync(target), "dest must not exist after give-up").toBe(false);
    expect(
      fs.existsSync(`${target}.download`),
      "temp file must be cleaned up after give-up",
    ).toBe(false);
  });

  it("names the artifact and the host in the terminal error", async () => {
    const target = dest("named.bin");
    let err: unknown;
    try {
      await downloadToFileWithStallGuard(`${server.origin}/stall-mid-body`, target, {
        label: "mobileclip_blt.ts",
        idleTimeoutMs: 200,
        maxAttempts: 1,
        doFetch: viaPlainFetch,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DownloadFailedError);
    const msg = (err as Error).message;
    expect(msg).toContain("mobileclip_blt.ts");
    expect(msg).toContain("127.0.0.1");
  });

  it("does NOT abort a slow but steadily-progressing download", async () => {
    // Total wall time (~1.2s) far exceeds the idle deadline (400ms). A flat
    // timeout would kill this; an idle deadline must not.
    const target = dest("slow.bin");
    const totalMs = SLOW_CHUNK_COUNT * SLOW_CHUNK_INTERVAL_MS;
    expect(totalMs).toBeGreaterThan(400);

    const res = await downloadToFileWithStallGuard(
      `${server.origin}/slow-but-steady`,
      target,
      {
        idleTimeoutMs: 400,
        maxAttempts: 1,
        doFetch: viaPlainFetch,
      },
    );

    const expectedBytes = SLOW_CHUNK.length * SLOW_CHUNK_COUNT;
    expect(res.bytesDownloaded).toBe(expectedBytes);
    expect(fs.statSync(res.tmpPath).size).toBe(expectedBytes);
  });

  it("computes the sha256 over the streamed bytes", async () => {
    const target = dest("hashed.bin");
    const res = await downloadToFileWithStallGuard(`${server.origin}/ok`, target, {
      idleTimeoutMs: 2_000,
      doFetch: viaPlainFetch,
    });

    const expected = createHash("sha256").update(OK_BODY).digest("hex");
    expect(res.sha256).toBe(expected);
    expect(fs.readFileSync(res.tmpPath)).toEqual(OK_BODY);
  });

  it("writes to <dest>.download and does not touch dest (caller verifies first)", async () => {
    const target = dest("untouched.bin");
    const res = await downloadToFileWithStallGuard(`${server.origin}/ok`, target, {
      idleTimeoutMs: 2_000,
      doFetch: viaPlainFetch,
    });

    expect(res.tmpPath).toBe(`${target}.download`);
    // The real path stays empty until the caller has checked the hash — a
    // corrupt body must never be able to land at the destination.
    expect(fs.existsSync(target)).toBe(false);
  });

  it("retries a flaky download and does not append the failed attempt's bytes", async () => {
    // /flaky sends 4 bytes then stalls on hit 1, and the full body on hit 2.
    // If the retry appended instead of truncating, the file would be
    // OK_BODY.length + 4 and the hash would not match.
    const target = dest("flaky.bin");
    const retries: number[] = [];

    const res = await downloadToFileWithStallGuard(`${server.origin}/flaky`, target, {
      idleTimeoutMs: 300,
      maxAttempts: 3,
      backoffMs: [10],
      doFetch: viaPlainFetch,
      onRetry: (info) => retries.push(info.attempt),
    });

    expect(retries).toEqual([1]);
    expect(res.bytesDownloaded).toBe(OK_BODY.length);
    expect(fs.readFileSync(res.tmpPath)).toEqual(OK_BODY);
    expect(res.sha256).toBe(createHash("sha256").update(OK_BODY).digest("hex"));
  });

  it("creates missing parent directories (matanyone/ is a nested dest)", async () => {
    const target = path.join(tmpDir, "nested", "deeper", "model.safetensors");
    const res = await downloadToFileWithStallGuard(`${server.origin}/ok`, target, {
      idleTimeoutMs: 2_000,
      doFetch: viaPlainFetch,
    });
    expect(fs.existsSync(res.tmpPath)).toBe(true);
  });

  it("does not retry a permanent 404", async () => {
    const target = dest("missing.bin");
    const retries: number[] = [];
    await expect(
      downloadToFileWithStallGuard(`${server.origin}/missing`, target, {
        idleTimeoutMs: 2_000,
        maxAttempts: 3,
        backoffMs: [10],
        doFetch: viaPlainFetch,
        onRetry: (info) => retries.push(info.attempt),
      }),
    ).rejects.toBeInstanceOf(DownloadFailedError);
    expect(retries, "a 404 is permanent — retrying it just wastes time").toEqual([]);
  });
});
