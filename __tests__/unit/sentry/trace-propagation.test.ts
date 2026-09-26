/**
 * libi propagates Sentry trace headers to NO host.
 *
 * Left unset, `tracePropagationTargets` makes the Node SDK add `sentry-trace`
 * and `baggage` (release, environment, public key, trace ids) to EVERY
 * outgoing fetch and http request — the catalog's use notice, fal, ElevenLabs,
 * anything — and it does so even for a user who opted out of crash reports,
 * because the opt-out gates the transport, not the instrumentation. The privacy
 * policy says the use notice "carries nothing else". No libi backend consumes
 * libi traces, so the rule is simply: none, anywhere.
 *
 * The browser SDK's default is same-origin only, which today means the local
 * studio server; it is pinned to `[]` too so the rule is one rule, and a change
 * of SDK default cannot quietly widen it.
 *
 * The wire-level proof (a real SDK, a real request) is
 * __tests__/integration/sentry/use-notice-trace-headers.test.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const initCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@sentry/nextjs", () => ({
  init: (options: Record<string, unknown>) => {
    initCalls.push(options);
  },
  makeNodeTransport: () => ({}),
  makeFetchTransport: () => ({}),
  addEventProcessor: () => {},
  captureRouterTransitionStart: () => {},
}));
// Off, so the client config skips its fire-and-forget reconcile round-trip.
vi.mock("@/lib/sentry/config", () => ({
  SENTRY_ENABLED: false,
  SENTRY_KILL_SWITCHED: false,
  SENTRY_DSN: "https://x@example.ingest.sentry.io/1",
  SENTRY_ENVIRONMENT: "test",
}));
vi.mock("@/lib/db/settings", () => ({ getCrashReportSettings: () => ({ choice: "unset" }) }));

afterEach(() => {
  initCalls.length = 0;
  vi.resetModules();
});

describe("tracePropagationTargets is [] in every Sentry.init", () => {
  it("server (sentry.server.config.ts — also the packaged Electron main process, which runs Next in-process)", async () => {
    await import("@/sentry.server.config");
    expect(initCalls).toHaveLength(1);
    expect(initCalls[0].tracePropagationTargets).toEqual([]);
  });

  it("browser (instrumentation-client.ts)", async () => {
    await import("@/instrumentation-client");
    expect(initCalls).toHaveLength(1);
    expect(initCalls[0].tracePropagationTargets).toEqual([]);
  });

  it("no other file calls Sentry.init — a new one must be added above", () => {
    const root = path.resolve(__dirname, "../../..");
    const skip = new Set(["node_modules", ".next", ".git", "dist", "out", "__tests__", "docs-local", ".claude", "coverage"]);
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name) || entry.name.startsWith(".")) continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) && /^\s*Sentry\.init\(/m.test(fs.readFileSync(p, "utf8"))) {
          found.push(path.relative(root, p));
        }
      }
    };
    walk(root);
    expect(found.sort()).toEqual(["instrumentation-client.ts", "sentry.server.config.ts"]);
  });
});
