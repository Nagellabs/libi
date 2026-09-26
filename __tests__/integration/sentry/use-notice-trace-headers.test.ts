/**
 * The catalog use notice leaves the machine without Sentry's trace headers.
 *
 * client.test.ts checks the notice's headers at a MOCKED fetch, which cannot
 * see what the SDK's fetch instrumentation injects below it: with
 * `tracePropagationTargets` unset, a release build added `sentry-trace` and
 * `baggage` (release, environment, public key, trace ids) to the notice — and
 * to every other outbound request — while the privacy policy says the notice
 * "carries nothing else".
 *
 * So this runs the REAL sentry.server.config.ts through the real
 * @sentry/nextjs SDK, enabled as a release build is, and captures the notice
 * as a local listener receives it. Only the envelope transport is replaced
 * (nothing is sent to Sentry), and the site origin points at the listener.
 * The control case proves the capture can see injected headers at all, so a
 * pass is not just the instrumentation failing to load under vitest.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/nextjs";

const site = vi.hoisted(() => ({ url: "http://127.0.0.1:1" }));

vi.mock("@/lib/site-url", () => ({
  PRODUCTION_SITE_URL: "https://libi.nagellabs.com",
  get SITE_URL() {
    return site.url;
  },
}));
// Enabled, as a release build bakes it (NEXT_PUBLIC_LIBI_SENTRY=1).
vi.mock("@/lib/sentry/config", () => ({
  SENTRY_ENABLED: true,
  SENTRY_KILL_SWITCHED: false,
  SENTRY_DSN: "https://0123456789abcdef0123456789abcdef@o1.ingest.sentry.io/1",
  SENTRY_ENVIRONMENT: "production",
}));
// Nothing may reach Sentry from a test: an envelope transport that drops everything.
vi.mock("@/lib/sentry/gated-transport", () => ({
  gateTransport: () => () => ({ send: async () => ({}), flush: async () => true }),
}));
vi.mock("@/lib/db/settings", () => ({ getCrashReportSettings: () => ({ choice: "on" }) }));

const ID = "abcdefghijklmnopqrst";
let server: http.Server;
const received: http.IncomingHttpHeaders[] = [];

beforeAll(async () => {
  vi.stubEnv("LIBI_TEST_MODE", undefined);
  server = http.createServer((req, res) => {
    received.push(req.headers);
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  site.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await import("@/sentry.server.config");
});

afterAll(async () => {
  await Sentry.close(0);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
});

async function sendNotice(): Promise<http.IncomingHttpHeaders> {
  const { reportUse } = await import("@/lib/templates/cloud/client");
  received.length = 0;
  expect(await reportUse(ID)).toEqual({ ok: true });
  expect(received).toHaveLength(1);
  return received[0];
}

describe("the use notice on the wire, with Sentry initialised as a release build", () => {
  it("Sentry is live in this process — the fetch instrumentation is armed", () => {
    expect(Sentry.getClient()?.getOptions().enabled).toBe(true);
  });

  it("control: without the setting, the SDK does add sentry-trace and baggage", async () => {
    const options = Sentry.getClient()!.getOptions();
    const pinned = options.tracePropagationTargets;
    options.tracePropagationTargets = undefined;
    try {
      const headers = await sendNotice();
      expect(headers["sentry-trace"]).toBeTruthy();
      expect(headers.baggage).toMatch(/sentry-environment=production/);
    } finally {
      options.tracePropagationTargets = pinned;
    }
  });

  it("carries no sentry-trace, no baggage, no traceparent", async () => {
    const headers = await sendNotice();
    expect(headers["sentry-trace"]).toBeUndefined();
    expect(headers.baggage).toBeUndefined();
    expect(headers.traceparent).toBeUndefined();
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
  });
});
