import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { SURFACE_TAG, detectSurface } from "@/lib/sentry/surface";
import type { scrubEvent as ScrubEvent } from "@/lib/sentry/scrub";
import type { setCrashReportChoice as SetCrashReportChoice } from "@/lib/sentry/enabled";

// lib/sentry/surface.ts answers "Electron shell or npx?" for every Sentry
// event. Sentry's own contexts cannot: the Electron renderer reports as Chrome
// on macOS, exactly like an npx user in Chrome.

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  process.env = { ...ORIGINAL_ENV };
});

describe("detectSurface", () => {
  it("reports electron in a renderer carrying the preload bridge", () => {
    (globalThis as { window?: unknown }).window = { electronAPI: { platform: "darwin" } };

    expect(detectSurface()).toBe("electron");
  });

  it("reports web in a plain browser", () => {
    // `npx @nagellabs/libi` — a real browser, no contextBridge global.
    (globalThis as { window?: unknown }).window = {};

    expect(detectSurface()).toBe("web");
  });

  it("reports electron on the server when the shell set its env marker", () => {
    // electron/main.ts:506 sets this before handing off to the runtime.
    delete process.env.LIBI_SHELL_API_MIN;
    process.env.LIBI_SHELL_API_MIN = "1";

    expect(detectSurface()).toBe("electron");
  });

  it("reports web on the server under npx, where nothing sets the marker", () => {
    delete process.env.LIBI_SHELL_API_MIN;

    expect(detectSurface()).toBe("web");
  });

  it("prefers the browser signal over the server one when both could apply", () => {
    // The Electron RENDERER can inherit the shell's env through the dev
    // launcher. The window check must win, so a plain browser pointed at a
    // dev server started by the shell is still reported as web.
    process.env.LIBI_SHELL_API_MIN = "1";
    (globalThis as { window?: unknown }).window = {};

    expect(detectSurface()).toBe("web");
  });
});

describe("the surface tag survives scrubbing", () => {
  // THE REAL RISK. scrub.ts#scrubCommonEventFields runs `redactDeep` over
  // `event.tags`, which REPLACES any value whose key looks secret. A tag that
  // gets redacted on its way out is worse than no tag: it looks present in the
  // code and is useless in Sentry, and nobody notices until they try to filter
  // by it. Both event paths are covered because feedback and errors take
  // different hooks.
  let scrubEvent: typeof ScrubEvent;
  let setCrashReportChoice: typeof SetCrashReportChoice;

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_LIBI_SENTRY = "1";
    ({ scrubEvent } = await import("@/lib/sentry/scrub"));
    ({ setCrashReportChoice } = await import("@/lib/sentry/enabled"));
  });

  it("keeps the tag on an error event", () => {
    setCrashReportChoice("on");
    // `type: undefined` is what makes this an ERROR event to the SDK
    // (@sentry/core client.js:798) — the branch scrubEvent actually handles.
    const event = { type: undefined, tags: { [SURFACE_TAG]: "electron" } };

    const out = scrubEvent(event);

    expect(out?.tags?.[SURFACE_TAG]).toBe("electron");
    setCrashReportChoice("unset");
  });
});
