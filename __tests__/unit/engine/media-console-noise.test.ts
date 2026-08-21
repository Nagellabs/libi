import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BENIGN_MEDIA_CONSOLE_ERRORS,
  isBenignMediaConsoleError,
  installMediaConsoleNoiseFilter,
} from "@/lib/engine/media-console-noise";

/** A console stand-in so no test ever patches the real one. */
function fakeConsole() {
  return { error: vi.fn(), warn: vi.fn() } as unknown as Console;
}

/** The exact strings mediabunny logs, copied from its source. */
const VIDEO_GC =
  "A VideoSample was garbage collected without first being closed. For proper resource management," +
  " make sure to call close() on all your VideoSamples as soon as you're done using them.";
const AUDIO_GC =
  "An AudioSample was garbage collected without first being closed. For proper resource management," +
  " make sure to call close() on all your AudioSamples as soon as you're done using them.";
const RETRY = "Retrying failed fetch. Error:";

describe("isBenignMediaConsoleError", () => {
  it("matches the VideoSample GC diagnostic — the message that blocked the editor", () => {
    expect(isBenignMediaConsoleError([VIDEO_GC])).toBe(true);
  });

  it("matches the AudioSample GC diagnostic too (same finalizer, audio side)", () => {
    expect(isBenignMediaConsoleError([AUDIO_GC])).toBe(true);
  });

  it("matches the per-attempt retry line, which arrives with an Error argument", () => {
    expect(isBenignMediaConsoleError([RETRY, new TypeError("Failed to fetch")])).toBe(true);
  });

  it("does NOT match an ordinary application error", () => {
    expect(isBenignMediaConsoleError(["TypeError: cannot read properties of null"])).toBe(false);
    expect(isBenignMediaConsoleError([new Error("boom")])).toBe(false);
    expect(isBenignMediaConsoleError([])).toBe(false);
  });

  it("does NOT match libi's own give-up warning, which must stay visible", () => {
    expect(
      isBenignMediaConsoleError([
        "[media] giving up on http://127.0.0.1:3456/x after 5 failed fetches:",
        "Failed to fetch",
      ]),
    ).toBe(false);
  });

  it("survives non-string arguments without throwing", () => {
    expect(isBenignMediaConsoleError([null, undefined, 42, { a: 1 }])).toBe(false);
  });

  it("every documented pattern carries a reason", () => {
    expect(BENIGN_MEDIA_CONSOLE_ERRORS.length).toBeGreaterThan(0);
    for (const entry of BENIGN_MEDIA_CONSOLE_ERRORS) {
      expect(entry.pattern.length).toBeGreaterThan(0);
      expect(entry.why.length).toBeGreaterThan(0);
    }
  });
});

describe("installMediaConsoleNoiseFilter", () => {
  const uninstalls: Array<() => void> = [];
  afterEach(() => {
    while (uninstalls.length) uninstalls.pop()!();
  });

  function install(target: Console) {
    const off = installMediaConsoleNoiseFilter(target);
    uninstalls.push(off);
    return off;
  }

  it("downgrades a benign diagnostic to warn instead of error", () => {
    const c = fakeConsole();
    const original = c.error;
    install(c);

    c.error(VIDEO_GC);

    expect(original).not.toHaveBeenCalled();
    expect(c.warn).toHaveBeenCalledWith("[media][benign]", VIDEO_GC);
  });

  it("passes a real error straight through, arguments intact", () => {
    const c = fakeConsole();
    const original = c.error;
    install(c);

    const cause = new Error("boom");
    c.error("render failed", cause);

    expect(original).toHaveBeenCalledWith("render failed", cause);
    expect(c.warn).not.toHaveBeenCalled();
  });

  it("uninstall restores the original console.error", () => {
    const c = fakeConsole();
    const original = c.error;
    const off = install(c);

    off();
    expect(c.error).toBe(original);

    c.error(VIDEO_GC);
    expect(original).toHaveBeenCalledWith(VIDEO_GC);
  });

  it("is idempotent — a second install does not double-wrap or lose the original", () => {
    const c = fakeConsole();
    const original = c.error;
    install(c);
    const afterFirst = c.error;

    const secondOff = installMediaConsoleNoiseFilter(c);
    expect(c.error).toBe(afterFirst);

    secondOff(); // the no-op uninstall must not unwind the real filter
    c.error(VIDEO_GC);
    expect(original).not.toHaveBeenCalled();
    expect(c.warn).toHaveBeenCalledTimes(1);
  });

  it("uninstall is a no-op when someone else patched console.error after us", () => {
    const c = fakeConsole();
    const off = install(c);

    const later = vi.fn();
    c.error = later as unknown as Console["error"];
    off();

    expect(c.error).toBe(later);
  });
});

describe("wiring", () => {
  it("is mounted in the root layout — an uninstalled filter is a silent no-op", () => {
    const layout = readFileSync(
      join(process.cwd(), "app", "layout.tsx"),
      "utf8",
    );
    expect(layout).toContain("MediaConsoleNoiseFilter");
    expect(layout).toContain("<MediaConsoleNoiseFilter />");
  });

  it("the provider gates itself to non-production", () => {
    const provider = readFileSync(
      join(process.cwd(), "components", "providers", "media-console-noise.tsx"),
      "utf8",
    );
    expect(provider).toContain('process.env.NODE_ENV === "production"');
    expect(provider).toContain("installMediaConsoleNoiseFilter");
  });
});
