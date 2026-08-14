import { describe, it, expect, vi, afterEach } from "vitest";
import { SENTRY_DSN } from "@/lib/sentry/config";

const SENTRY_CONNECT = new URL(SENTRY_DSN).origin;

/** Load a fresh `csp.ts` with SENTRY_ENABLED forced to `enabled` — the module
 *  computes SENTRY_CONNECT once at import time, so exercising both states
 *  requires a fresh module instance per state, not just re-calling buildCsp(). */
async function buildCspWithSentryEnabled(enabled: boolean): Promise<string> {
  vi.resetModules();
  vi.doMock("@/lib/sentry/config", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/sentry/config")>();
    return { ...actual, SENTRY_ENABLED: enabled };
  });
  const { buildCsp } = await import("@/lib/security/csp");
  return buildCsp();
}

afterEach(() => {
  vi.doUnmock("@/lib/sentry/config");
  vi.resetModules();
});

describe("buildCsp", () => {
  it("locks connect-src to self (the load-bearing anti-exfiltration directive)", async () => {
    const csp = await buildCspWithSentryEnabled(true);
    expect(csp).toContain("connect-src 'self'");
  });

  it("allows the loopback terminal WebSocket on any port (dynamic ws-server port; on-machine, so anti-exfil holds)", async () => {
    const csp = await buildCspWithSentryEnabled(true);
    const connectSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("connect-src"))!;
    expect(connectSrc).toContain("ws://127.0.0.1:*");
    // Loopback only — no wildcard-host or non-loopback ws source may appear.
    const wsSources = connectSrc.match(/wss?:\/\/[^\s]+/g) ?? [];
    for (const s of wsSources) {
      expect(s).toBe("ws://127.0.0.1:*");
    }
  });

  it("restricts objects/plugins to self (same-origin PDF embed allowed, cross-origin forbidden)", async () => {
    const csp = await buildCspWithSentryEnabled(true);
    expect(csp).toContain("object-src 'self'");
  });

  it("restricts frames to self", async () => {
    const csp = await buildCspWithSentryEnabled(true);
    expect(csp).toContain("frame-src 'self'");
  });

  it("restricts form submissions to self", async () => {
    const csp = await buildCspWithSentryEnabled(true);
    expect(csp).toContain("form-action 'self'");
  });

  it("keeps unsafe-eval in script-src (required for new Function draw compilation)", async () => {
    const csp = await buildCspWithSentryEnabled(true);
    const scriptSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src"));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).toContain("'unsafe-eval'");
  });

  it("allows blob: workers (required for MediaBunny decode workers)", async () => {
    const csp = await buildCspWithSentryEnabled(true);
    const workerSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("worker-src"));
    expect(workerSrc).toBeDefined();
    expect(workerSrc).toContain("blob:");
  });

  it("allows the Sentry ingest host in connect-src (the third deliberate trade-off) when Sentry is actually enabled", async () => {
    const csp = await buildCspWithSentryEnabled(true);
    const connectSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("connect-src"))!;
    expect(connectSrc).toContain(SENTRY_CONNECT);
  });

  it("omits the Sentry ingest host entirely when SENTRY_ENABLED is false — dev clones, kill-switched installs, and opt-out users get no exfil-capable external origin for a reporter that will never send anything", async () => {
    const csp = await buildCspWithSentryEnabled(false);
    const connectSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("connect-src"))!;
    expect(connectSrc).not.toContain(SENTRY_CONNECT);
    expect(connectSrc).not.toContain("sentry.io");
  });

  it("allowlists ONLY the GA4 hosts, our own marketing site, and (when enabled) the Sentry ingest host", async () => {
    const csp = await buildCspWithSentryEnabled(true);
    const dir = (name: string) =>
      csp
        .split(";")
        .map((d) => d.trim())
        .find((d) => d.startsWith(name)) ?? "";
    // gtag.js loads from googletagmanager; beacons go to google-analytics.
    expect(dir("script-src")).toContain("https://www.googletagmanager.com");
    expect(dir("connect-src")).toContain("https://www.google-analytics.com");
    expect(dir("connect-src")).toContain("https://*.google-analytics.com");
    expect(dir("img-src")).toContain("https://www.google-analytics.com");
    // The waitlist POST target (lib/waitlist-api.ts) — connect-src only. It has
    // no business in script-src or img-src, and must not drift into them.
    expect(dir("connect-src")).toContain("https://libi.nagellabs.com");
    expect(dir("script-src")).not.toContain("libi.nagellabs.com");
    expect(dir("img-src")).not.toContain("libi.nagellabs.com");
    // The Sentry ingest host — connect-src only (crash reports are POSTed, never
    // scripts/images loaded from it), and must not drift into other directives.
    expect(dir("connect-src")).toContain(SENTRY_CONNECT);
    expect(dir("script-src")).not.toContain("sentry.io");
    expect(dir("img-src")).not.toContain("sentry.io");
    // Nothing beyond those leaks into any fetch/script directive. This is the
    // anti-exfiltration guard: every addition here widens where a compromised
    // renderer could send data, so each one must be justified above it.
    const sentryHostEscaped = SENTRY_CONNECT.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    const allowedHostPattern = new RegExp(
      `google-analytics\\.com|googletagmanager\\.com|^https:\\/\\/libi\\.nagellabs\\.com$|^${sentryHostEscaped}$`,
    );
    for (const name of ["connect-src", "script-src", "img-src"]) {
      const hosts = dir(name).match(/https?:\/\/[^\s]+/g) ?? [];
      for (const h of hosts) {
        expect(h).toMatch(allowedHostPattern);
      }
    }
  });

  it("emits the exact directive set when Sentry is enabled", async () => {
    const csp = await buildCspWithSentryEnabled(true);
    expect(csp).toBe(
      "default-src 'self'; " +
        `connect-src 'self' ws://127.0.0.1:* https://www.google-analytics.com https://*.google-analytics.com https://www.googletagmanager.com https://libi.nagellabs.com ${SENTRY_CONNECT}; ` +
        "img-src 'self' data: blob: https://www.google-analytics.com https://*.google-analytics.com; " +
        "media-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; " +
        "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://www.googletagmanager.com; " +
        "worker-src 'self' blob:; " +
        "frame-src 'self'; object-src 'self'; base-uri 'self'; form-action 'self'",
    );
  });

  it("emits the exact directive set when Sentry is disabled (no ingest host at all)", async () => {
    const csp = await buildCspWithSentryEnabled(false);
    expect(csp).toBe(
      "default-src 'self'; " +
        "connect-src 'self' ws://127.0.0.1:* https://www.google-analytics.com https://*.google-analytics.com https://www.googletagmanager.com https://libi.nagellabs.com; " +
        "img-src 'self' data: blob: https://www.google-analytics.com https://*.google-analytics.com; " +
        "media-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; " +
        "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://www.googletagmanager.com; " +
        "worker-src 'self' blob:; " +
        "frame-src 'self'; object-src 'self'; base-uri 'self'; form-action 'self'",
    );
  });
});
