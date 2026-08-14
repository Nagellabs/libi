/**
 * Task #54 — the packaged app hung FOREVER on first boot when a dependency
 * download's socket went ESTABLISHED-but-silent (observed with ffmpeg).
 *
 * These tests exercise `downloadBufferWithStallGuard` against a real local
 * HTTP server that deterministically reproduces the stall (headers sent,
 * body withheld). The transport is injected as plain `fetch` so the
 * production HTTPS-only enforcement stays intact while the test streams
 * from 127.0.0.1.
 *
 * The load-bearing assertions:
 *   - a stalled stream aborts on the IDLE deadline (bounded time, not never)
 *   - a slow-but-PROGRESSING stream is NOT aborted even though its total
 *     duration far exceeds the idle deadline — proving this is an idle
 *     deadline, not a flat overall timeout
 *   - retries happen, are bounded, and are visible via onRetry
 *   - the terminal error names host + URL + dependency + bytes received
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import {
  downloadBufferWithStallGuard,
  DownloadFailedError,
  DownloadStalledError,
} from "@/lib/security/download-verify";
import {
  looksUnreachable,
  extractUnreachableHost,
} from "@/lib/runtime/network-errors";
import {
  startStallServer,
  type StallServer,
  STALL_BODY_CHUNK,
  STALL_TOTAL_BYTES,
  OK_BODY,
  SLOW_CHUNK,
  SLOW_CHUNK_COUNT,
  SLOW_CHUNK_INTERVAL_MS,
} from "../../helpers/stall-server";

// Plain fetch as transport: the stall server is loopback HTTP; production
// keeps using fetchWithHttpsOnlyRedirects (covered by its own tests).
const viaPlainFetch = (url: string, init?: RequestInit) => fetch(url, init);

let server: StallServer;

beforeAll(async () => {
  server = await startStallServer();
});

afterAll(async () => {
  await server.close();
});

describe("downloadBufferWithStallGuard", () => {
  it("aborts a stalled stream on the idle deadline, in bounded time", async () => {
    const started = Date.now();
    let caught: unknown;
    try {
      await downloadBufferWithStallGuard(`${server.origin}/stall-mid-body`, {
        doFetch: viaPlainFetch,
        idleTimeoutMs: 200,
        maxAttempts: 1,
        label: "ffmpeg",
      });
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - started;

    expect(caught).toBeInstanceOf(DownloadFailedError);
    const failure = caught as DownloadFailedError;
    // Bounded: idle deadline is 200ms; anything under 3s proves we did not
    // sit on the silent socket (the pre-fix code waited forever).
    expect(elapsed).toBeLessThan(3_000);
    expect(failure.lastError).toBeInstanceOf(DownloadStalledError);
    expect(failure.bytesDownloaded).toBe(STALL_BODY_CHUNK.length);
    expect(failure.bytesTotal).toBe(STALL_TOTAL_BYTES);
  });

  it("does NOT abort a slow-but-progressing stream (idle deadline, not flat timeout)", async () => {
    // Total transfer time ≈ 12 chunks × 100ms = ~1.2s, far beyond the 400ms
    // idle deadline. Every chunk re-arms the timer, so the download must
    // complete. A flat 400ms overall timeout would kill it — this is the
    // test that proves the difference.
    const started = Date.now();
    const buf = await downloadBufferWithStallGuard(
      `${server.origin}/slow-but-steady`,
      {
        doFetch: viaPlainFetch,
        idleTimeoutMs: 400,
        maxAttempts: 1,
      },
    );
    const elapsed = Date.now() - started;

    expect(buf.length).toBe(SLOW_CHUNK.length * SLOW_CHUNK_COUNT);
    // Sanity: the transfer genuinely outlived the idle deadline.
    expect(elapsed).toBeGreaterThan(400);
    expect(elapsed).toBeGreaterThanOrEqual(
      (SLOW_CHUNK_COUNT - 2) * SLOW_CHUNK_INTERVAL_MS,
    );
  });

  it("retries are bounded and visible; terminal error counts the attempts", async () => {
    const retries: Array<{ attempt: number; maxAttempts: number }> = [];
    let caught: unknown;
    try {
      await downloadBufferWithStallGuard(`${server.origin}/stall-mid-body`, {
        doFetch: viaPlainFetch,
        idleTimeoutMs: 100,
        maxAttempts: 3,
        backoffMs: [10, 10],
        label: "ffmpeg",
        onRetry: (info) =>
          retries.push({ attempt: info.attempt, maxAttempts: info.maxAttempts }),
      });
    } catch (err) {
      caught = err;
    }

    // 3 attempts → exactly 2 retry notifications, then a terminal throw.
    expect(retries).toEqual([
      { attempt: 1, maxAttempts: 3 },
      { attempt: 2, maxAttempts: 3 },
    ]);
    expect(caught).toBeInstanceOf(DownloadFailedError);
    expect((caught as DownloadFailedError).attempts).toBe(3);
    expect((caught as Error).message).toContain("3 attempts");
  });

  it("recovers when a retry succeeds", async () => {
    const retries: number[] = [];
    const buf = await downloadBufferWithStallGuard(`${server.origin}/flaky`, {
      doFetch: viaPlainFetch,
      idleTimeoutMs: 150,
      maxAttempts: 3,
      backoffMs: [10],
      onRetry: (info) => retries.push(info.attempt),
    });

    expect(buf.equals(OK_BODY)).toBe(true);
    expect(retries).toEqual([1]);
    expect(server.hits.get("/flaky")).toBe(2);
  });

  it("aborts a stall BEFORE headers too (idle deadline covers the fetch phase)", async () => {
    const started = Date.now();
    await expect(
      downloadBufferWithStallGuard(`${server.origin}/stall-pre-headers`, {
        doFetch: viaPlainFetch,
        idleTimeoutMs: 200,
        maxAttempts: 1,
      }),
    ).rejects.toBeInstanceOf(DownloadFailedError);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("does not retry a permanent HTTP 404", async () => {
    const retries: number[] = [];
    let caught: unknown;
    try {
      await downloadBufferWithStallGuard(`${server.origin}/missing`, {
        doFetch: viaPlainFetch,
        idleTimeoutMs: 500,
        maxAttempts: 3,
        onRetry: (info) => retries.push(info.attempt),
      });
    } catch (err) {
      caught = err;
    }

    expect(retries).toEqual([]);
    expect(server.hits.get("/missing")).toBe(1);
    expect((caught as Error).message).toContain("HTTP 404");
    expect((caught as DownloadFailedError).attempts).toBe(1);
  });

  it("terminal error names host, URL, dependency and bytes received vs expected", async () => {
    let caught: unknown;
    try {
      await downloadBufferWithStallGuard(`${server.origin}/stall-mid-body`, {
        doFetch: viaPlainFetch,
        idleTimeoutMs: 100,
        maxAttempts: 2,
        backoffMs: [10],
        label: "ffmpeg, ffprobe",
      });
    } catch (err) {
      caught = err;
    }

    const message = (caught as Error).message;
    const host = new URL(server.origin).host; // 127.0.0.1:<port>
    expect(message).toContain('"ffmpeg, ffprobe"'); // which dependency
    expect(message).toContain(host); // which host
    expect(message).toContain(`${server.origin}/stall-mid-body`); // full URL
    expect(message).toContain("0.1 MB"); // bytes received (64 KiB ≈ 0.1 MB)
    expect(message).toContain("1.0 MB"); // bytes expected
    // Category A's fatal-hint classifier must route this into the
    // "name the host" network branch (lib/runtime/network-errors.ts).
    expect(looksUnreachable(message)).toBe(true);
    expect(extractUnreachableHost(message)).toBe("127.0.0.1");
  });

  it("streams byte-level progress with the content-length total", async () => {
    const ticks: Array<{ bytesDownloaded: number; bytesTotal: number | null }> = [];
    const buf = await downloadBufferWithStallGuard(`${server.origin}/ok`, {
      doFetch: viaPlainFetch,
      idleTimeoutMs: 1_000,
      maxAttempts: 1,
      onProgress: (p) => ticks.push({ ...p }),
    });

    expect(buf.equals(OK_BODY)).toBe(true);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[ticks.length - 1].bytesDownloaded).toBe(OK_BODY.length);
    expect(ticks[ticks.length - 1].bytesTotal).toBe(OK_BODY.length);
    // Monotonic byte counts.
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i].bytesDownloaded).toBeGreaterThanOrEqual(
        ticks[i - 1].bytesDownloaded,
      );
    }
  });
});
