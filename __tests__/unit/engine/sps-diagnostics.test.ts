/**
 * mediabunny's "Error parsing HEVC SPS" line is said once per file per session,
 * naming the file, instead of once (or, in MPEG-TS, several times) per open
 * with no file (review M3, round 2 M4). Attribution holds whether the parse
 * runs synchronously in the first getDecoderConfig() or after an awaited read
 * (HEVC without hvcC, MPEG-TS), and a line logged outside any region is left
 * exactly as mediabunny wrote it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const listeners: Array<(args: unknown[]) => void> = [];
vi.mock("mediabunny", () => ({
  Logging: {
    on: (_event: string, fn: (args: unknown[]) => void) => {
      listeners.push(fn);
      return () => {};
    },
  },
}));

import { attributeMediaLogs, resetSpsDiagnosticsForTest } from "@/lib/engine/sps-diagnostics";

/** What mediabunny's Logging._error does: raise the event, then write the line. */
function mediabunnyLogsSpsError() {
  const args = ["Error parsing HEVC SPS:", new Error("Invalid exponential-Golomb code.")];
  for (const l of listeners) l(args);
  console.error(...args);
}

let errorSpy: ReturnType<typeof vi.fn<(...a: unknown[]) => void>>;
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  resetSpsDiagnosticsForTest();
  errorSpy = vi.fn<(...a: unknown[]) => void>();
  // The filter wraps whatever console.error is when it installs; install it
  // once over a spy that each test re-points.
  if (!(globalThis as { __spsSpy?: unknown }).__spsSpy) {
    const holder: { current: (...a: unknown[]) => void } = { current: errorSpy };
    (globalThis as { __spsSpy?: unknown }).__spsSpy = holder;
    console.error = ((...a: unknown[]) => holder.current(...a)) as Console["error"];
    await attributeMediaLogs("/install", async () => {});
  }
  ((globalThis as unknown as { __spsSpy: { current: unknown } }).__spsSpy).current = errorSpy;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warnSpy.mockRestore());

describe("attributeMediaLogs", () => {
  it("synchronous parse: one line per file with the parser's error; mediabunny's own lines dropped", async () => {
    await attributeMediaLogs("/a", async () => mediabunnyLogsSpsError());
    await attributeMediaLogs("/a", async () => mediabunnyLogsSpsError()); // a second open
    await attributeMediaLogs("/b", async () => mediabunnyLogsSpsError());
    const lines = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("/a");
    expect(lines[0]).toContain("Invalid exponential-Golomb code.");
    expect(lines[1]).toContain("/b");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("a parse after an awaited read, several times (MPEG-TS): attributed to its file, even with another open queued", async () => {
    const ts = attributeMediaLogs("/ts", async () => {
      await new Promise((r) => setTimeout(r, 5));
      for (let i = 0; i < 6; i++) mediabunnyLogsSpsError();
    });
    const other = attributeMediaLogs("/clean", async () => {});
    await Promise.all([ts, other]);
    const lines = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("/ts");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("outside a region mediabunny's line passes untouched, and other errors always do (an AVC SPS failure)", async () => {
    mediabunnyLogsSpsError();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toBe("Error parsing HEVC SPS:");
    await attributeMediaLogs("/c", async () => console.error("Error parsing AVC SPS:", "x"));
    expect(errorSpy).toHaveBeenLastCalledWith("Error parsing AVC SPS:", "x");
  });

  it("returns fn's value and passes its error through", async () => {
    expect(await attributeMediaLogs("/d", async () => 7)).toBe(7);
    await expect(attributeMediaLogs("/e", async () => { throw new Error("nope"); })).rejects.toThrow("nope");
  });

  it("a stalled open stops holding the others up after a bound", async () => {
    vi.useFakeTimers();
    const stalled = attributeMediaLogs("/stall", () => new Promise(() => {}));
    void stalled;
    let ran = false;
    const next = attributeMediaLogs("/next", async () => { ran = true; });
    await vi.advanceTimersByTimeAsync(3100);
    await next;
    expect(ran).toBe(true);
    vi.useRealTimers();
  });
});
