/**
 * End-to-end proof of the bounded retry policy against REAL mediabunny and a
 * REAL unreachable server — the exact 2026-08-18 failure (a dev Electron window
 * outliving its Next server, every video source fetching a port nothing is
 * listening on).
 *
 * The unit tests cover the policy function's shape. This covers the claim that
 * actually matters: that mediabunny, driven by that policy, gives UP — the read
 * rejects, so `MediaBunnyFrameSource`'s catch blocks run and the console noise
 * ends. The paired case pins the default behaviour it replaced.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import net from "node:net";
import { Input, UrlSource, ALL_FORMATS } from "mediabunny";
import { mediaFetchRetryDelay, MAX_FETCH_RETRIES } from "@/lib/engine/media-fetch-retry";

/** A loopback URL guaranteed to refuse connections: bind a port, then free it. */
async function deadUrl(): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/api/files/video-file-1`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UrlSource against an unreachable server", () => {
  it("rejects instead of retrying forever", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const url = await deadUrl();
    const input = new Input({
      source: new UrlSource(url, { getRetryDelay: mediaFetchRetryDelay }),
      formats: ALL_FORMATS,
    });
    try {
      await expect(input.getPrimaryVideoTrack()).rejects.toThrow();
      // The whole point: it settles, and it settles because the POLICY gave up
      // — `mediaFetchRetryDelay` returned null and logged it — rather than
      // after the default's unbounded 16s-capped backoff. Asserted on the
      // policy's own give-up line rather than on a wall clock: elapsed
      // time here is set by how busy the machine is, and a "< 15 s" that only
      // ever fails under full-suite load teaches people to re-run until green.
      expect(
        warn.mock.calls.some(([m]) => String(m).includes("giving up on")),
      ).toBe(true);
    } finally {
      input.dispose();
    }
  }, 30_000);

  it("bounds mediabunny's per-attempt console.error to the retry budget", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // This is the line Next's dev overlay was surfacing as
    // "Console TypeError: Failed to fetch", over and over, forever.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const url = await deadUrl();
    const input = new Input({
      source: new UrlSource(url, { getRetryDelay: mediaFetchRetryDelay }),
      formats: ALL_FORMATS,
    });
    try {
      await expect(input.getPrimaryVideoTrack()).rejects.toThrow();
      expect(error.mock.calls.length).toBeLessThanOrEqual(MAX_FETCH_RETRIES);
    } finally {
      input.dispose();
    }
  }, 30_000);

  it("still spins without the policy — the behaviour being fixed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const url = await deadUrl();
    // No getRetryDelay ⇒ mediabunny's default, which only ever gives up on a
    // suspected CROSS-origin failure. This URL is same-origin-shaped and there
    // is no window in the test env, so the escape hatch cannot fire.
    const input = new Input({
      source: new UrlSource(url),
      formats: ALL_FORMATS,
    });
    const settled = input.getPrimaryVideoTrack().then(
      () => "settled" as const,
      () => "settled" as const,
    );
    const outcome = await Promise.race([
      settled,
      new Promise<"spinning">((r) => setTimeout(() => r("spinning"), 8_000)),
    ]);
    // dispose() is what stops it — the loop has no other exit. Do NOT wait on
    // `settled` unbounded: with mediabunny's default policy the pending
    // attempt can be inside a backoff sleep of up to 16 s when dispose lands,
    // and that wait — on top of this test's own 8 s observation window — is
    // what put the test at ~15 s idle and past its 30 s budget under
    // full-suite load. Both handlers are already attached to `settled`, so
    // leaving it pending cannot surface as an unhandled rejection.
    await Promise.race([settled, new Promise((r) => setTimeout(r, 2_000))]);
    expect(outcome).toBe("spinning");
  }, 30_000);
});
