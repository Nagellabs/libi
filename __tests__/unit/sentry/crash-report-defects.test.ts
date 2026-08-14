// @vitest-environment jsdom
//
// jsdom because the injected-seed reader is browser-side by construction — it
// reads a global the server wrote into the HTML, and off-browser it must
// return null.
/**
 * The four confirmed defects in the crash-report opt-out, all of which had a
 * published promise on the other side of them.
 *
 * F2 — `LIBI_SENTRY_DISABLED=1` never reached the browser in a prebuilt
 *      install. Next inlines `NEXT_PUBLIC_*` at build time, so the launcher's
 *      mirror only works under `next dev`; a release bundle carries the BUILD
 *      MACHINE's value. The published privacy policy (Nagellabs/libi-site)
 *      promises the switch works for command-line installs.
 * F1 — media filenames leaked via `request.url` (and Next's copy of it at
 *      `contexts.nextjs.request_path`). The Privacy tab says "your media file
 *      names are removed".
 * F4 — one session envelope per launch for opted-out users: the packaged app
 *      binds an ephemeral port, localStorage is origin-scoped INCLUDING the
 *      port, and `browserSessionIntegration` sends session-start synchronously
 *      inside `Sentry.init` — before any reconcile can resolve.
 * F3 — a failed boot read left the gate at `"unset"` (= reporting) for the
 *      whole process lifetime, silently reverting an explicit opt-out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/sentry/config", () => ({
  SENTRY_ENABLED: true,
  SENTRY_KILL_SWITCHED: false,
  SENTRY_DSN: "https://x@example.ingest.sentry.io/1",
  SENTRY_ENVIRONMENT: "test",
}));

import {
  readInjectedCrashReportConfig,
  setCrashReportChoice,
  setServerKillSwitch,
  shouldSendCrashReports,
  getCrashReportChoice,
} from "@/lib/sentry/enabled";
import { crashReportSeedScript } from "@/lib/sentry/seed-script";
import { redactPaths, scrubEvent } from "@/lib/sentry/scrub";

beforeEach(() => {
  setCrashReportChoice("unset");
  setServerKillSwitch(false);
});

// ── F2 ──────────────────────────────────────────────────────────────────────
describe("F2 — the kill-switch reaches a prebuilt renderer at runtime", () => {
  it("closes the gate even when the user's stored choice is an explicit on", () => {
    setCrashReportChoice("on");
    expect(shouldSendCrashReports()).toBe(true);
    setServerKillSwitch(true);
    expect(shouldSendCrashReports()).toBe(false);
  });

  it("does not corrupt the stored choice — lifting the switch restores it", () => {
    setCrashReportChoice("on");
    setServerKillSwitch(true);
    // The whole reason this is a SEPARATE flag rather than a write of "off":
    // the switch is an operator override, not a user decision.
    expect(getCrashReportChoice()).toBe("on");
    setServerKillSwitch(false);
    expect(shouldSendCrashReports()).toBe(true);
  });

  it("an explicit opt-out still wins when the switch is off", () => {
    setCrashReportChoice("off");
    setServerKillSwitch(false);
    expect(shouldSendCrashReports()).toBe(false);
  });
});

// ── F1 ──────────────────────────────────────────────────────────────────────
describe("F1 — media filenames in URLs", () => {
  it("redacts the filename from a piece-scoped media URL", () => {
    // Percent-encoded, because that is what a real `request.url` carries. The
    // pattern stops at whitespace on purpose: a URL cannot contain a raw
    // space, and allowing one would let a filename mentioned mid-sentence
    // swallow the rest of a log message.
    expect(redactPaths("/api/files/piece-123/My%20Divorce%20Announcement.mp4")).toBe(
      "/api/files/piece-123/[redacted]",
    );
  });

  it("redacts the filename from a global media URL", () => {
    expect(redactPaths("http://localhost:51234/api/files/global/therapy-session.mov")).toBe(
      "http://localhost:51234/api/files/global/[redacted]",
    );
  });

  // Keeping these intact is what makes a 500 on that route debuggable; the id
  // is opaque and carries no user content.
  it("leaves the by-id routes alone", () => {
    const url = "/api/files/by-id/2f1c9a44-0b1e-4e2d-9f00-9a1b2c3d4e5f/content";
    expect(redactPaths(url)).toBe(url);
    expect(redactPaths("/api/files/by-id/abc/proxy")).toBe("/api/files/by-id/abc/proxy");
  });

  it("scrubs request.url on the event — the field scrubCommonEventFields KEEPS", () => {
    const event = scrubEvent({
      request: { url: "http://localhost:3000/api/files/p1/holiday.mp4", method: "GET" },
    } as never);
    expect(event?.request?.url).toBe("http://localhost:3000/api/files/p1/[redacted]");
  });

  // The second carrier the reviewer missed: Next copies the same value here.
  it("scrubs Next's copy at contexts.nextjs.request_path", () => {
    const event = scrubEvent({
      contexts: { nextjs: { request_path: "/api/files/p1/holiday.mp4" } },
    } as never);
    expect(
      (event?.contexts?.nextjs as { request_path?: string } | undefined)?.request_path,
    ).toBe("/api/files/p1/[redacted]");
  });
});

// ── F4 ──────────────────────────────────────────────────────────────────────
describe("F4 — the synchronous, server-injected seed", () => {
  const g = globalThis as unknown as Record<string, unknown>;
  afterEach(() => {
    delete g.__libiCrashReports;
  });

  it("emits a script that assigns the persisted choice", () => {
    expect(crashReportSeedScript({ choice: "off", killSwitched: false })).toBe(
      'window.__libiCrashReports={choice:"off",killSwitched:false};',
    );
  });

  it("never emits an unknown choice into the page", () => {
    expect(
      crashReportSeedScript({ choice: '"</script><script>alert(1)', killSwitched: true }),
    ).toBe('window.__libiCrashReports={choice:"unset",killSwitched:true};');
  });

  it("reads the injected value back", () => {
    g.__libiCrashReports = { choice: "off", killSwitched: true };
    expect(readInjectedCrashReportConfig()).toEqual({ choice: "off", killSwitched: true });
  });

  // No seed ⇒ the localStorage mirror stays in charge, i.e. exactly the
  // previous behaviour. A route rendered without the root layout must not
  // change how the gate is seeded.
  it("returns null when the page carried no seed", () => {
    expect(readInjectedCrashReportConfig()).toBeNull();
  });

  it("returns null for a malformed seed rather than trusting it", () => {
    g.__libiCrashReports = { choice: "maybe" };
    expect(readInjectedCrashReportConfig()).toBeNull();
  });
});
