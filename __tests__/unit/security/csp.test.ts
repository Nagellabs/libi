import { describe, it, expect, vi, afterEach } from "vitest";
import { SENTRY_DSN } from "@/lib/sentry/config";
import { SOCIAL_PROVIDER_CATALOG, socialMediaOrigins } from "@/lib/social/catalog";
import { CATALOG_BUCKET_BASES } from "@/lib/templates/cloud/constants";

const SENTRY_CONNECT = new URL(SENTRY_DSN).origin;
/** The social providers' media hosts, as the policy should carry them — read
 *  from the catalog, never spelled out here, because the point of the change
 *  is that the CSP is DERIVED from the catalog. */
const SOCIAL_MEDIA = socialMediaOrigins().join(" ");
/** The public templates catalog's two bucket PATHS, spelled out rather than
 *  read from the constants: this is the pin on how narrow the allowance is,
 *  so a constant widened to the whole of storage.googleapis.com must fail
 *  here instead of flowing through. */
const CATALOG_SOURCES = [
  "https://storage.googleapis.com/libi-prod-templates/",
  "https://storage.googleapis.com/libi-dev-templates/",
];
const CATALOG_MEDIA = CATALOG_SOURCES.join(" ");

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

  it("admits the sandboxed overlay runtime as a child frame and forbids framing the app (spec §4.10)", async () => {
    const csp = await buildCspWithSentryEnabled(true);
    expect(csp).toContain("frame-src 'self'");
    expect(csp).toContain("child-src 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
  });

  it("lets the app frame its own responses (same-origin PDF <embed>) but nothing cross-origin", async () => {
    await buildCspWithSentryEnabled(true);
    const { cspForPath } = await import("@/lib/security/csp");
    // Chromium enforces frame-ancestors on <embed>: `'none'` on the file-content
    // response blanked the editor's PDF asset viewer (asset-media-view.tsx).
    const fileContent = cspForPath("/api/files/by-id/abc/content", "http://127.0.0.1:3456");
    const ancestors = fileContent.split(";").map((d) => d.trim()).filter((d) => d.startsWith("frame-ancestors"));
    expect(ancestors).toEqual(["frame-ancestors 'self'"]);
  });

  it("keeps the app's frame-ancestors 'self' off the overlay runtime page, which the studio must be able to frame", async () => {
    await buildCspWithSentryEnabled(true);
    const { cspForPath, OVERLAY_RUNTIME_PATH } = await import("@/lib/security/csp");
    const origin = "http://127.0.0.1:3456";
    const runtime = cspForPath(OVERLAY_RUNTIME_PATH, origin);
    expect(runtime).toContain(`frame-ancestors ${origin}`);
    expect(runtime).not.toContain("frame-ancestors 'self'");
    // One frame-ancestors per policy: a second would be ignored or, worse, win.
    expect(runtime.match(/frame-ancestors/g)).toHaveLength(1);
    expect(cspForPath("/editor", origin).match(/frame-ancestors/g)).toHaveLength(1);
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

  it("allowlists ONLY our own marketing site and (when enabled) the Sentry ingest host — no third-party host anywhere else", async () => {
    const csp = await buildCspWithSentryEnabled(true);
    const dir = (name: string) =>
      csp
        .split(";")
        .map((d) => d.trim())
        .find((d) => d.startsWith(name)) ?? "";
    // Analytics is server-only now (lib/analytics/collect-url.ts, sent from the
    // Next process, never the renderer) — no GA4 host belongs in this CSP at
    // all. gtag.js is gone; there is nothing left in script-src or img-src to
    // allowlist for it.
    expect(dir("script-src")).not.toContain("googletagmanager.com");
    expect(dir("connect-src")).not.toContain("google-analytics.com");
    expect(dir("img-src")).not.toContain("google-analytics.com");
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
      `^https:\\/\\/libi\\.nagellabs\\.com$|^${sentryHostEscaped}$`,
    );
    for (const name of ["connect-src", "script-src"]) {
      const hosts = dir(name).match(/https?:\/\/[^\s]+/g) ?? [];
      for (const h of hosts) {
        expect(h).toMatch(allowedHostPattern);
      }
    }
    // `img-src` and `media-src` additionally carry the social providers'
    // media origins and the templates catalog's two bucket paths — and
    // NOTHING else. Display sinks, so they do not widen where a compromised
    // renderer could SEND data (connect-src is untouched above), but they
    // still may not become a dumping ground.
    for (const name of ["img-src", "media-src"]) {
      for (const h of dir(name).match(/https?:\/\/[^\s]+/g) ?? []) {
        expect([...socialMediaOrigins(), ...CATALOG_SOURCES]).toContain(h);
      }
    }
  });

  it("allows each social provider's media origin in media-src and img-src — derived from the catalog, not hardcoded", async () => {
    const csp = await buildCspWithSentryEnabled(true);
    const dir = (name: string) =>
      csp
        .split(";")
        .map((d) => d.trim())
        .find((d) => d.startsWith(name)) ?? "";
    // Every provider libi ships, whichever one is connected: the header is
    // emitted per page response, long before any connection state is known.
    expect(SOCIAL_PROVIDER_CATALOG.length).toBeGreaterThan(0);
    for (const provider of SOCIAL_PROVIDER_CATALOG) {
      expect(provider.mediaOrigins.length).toBeGreaterThan(0);
      for (const origin of provider.mediaOrigins) {
        // Without these two, every post's preview is an empty black player
        // and the only signal is a console line (QA 2026-09-21, finding 2).
        expect(dir("media-src")).toContain(origin);
        expect(dir("img-src")).toContain(origin);
        // …and the widening stops there. A media host is not a fetch target.
        expect(dir("connect-src")).not.toContain(origin);
        expect(dir("script-src")).not.toContain(origin);
      }
    }
  });

  it("emits the exact directive set when Sentry is enabled", async () => {
    const csp = await buildCspWithSentryEnabled(true);
    expect(csp).toBe(
      "default-src 'self'; " +
        `connect-src 'self' ws://127.0.0.1:* https://libi.nagellabs.com ${SENTRY_CONNECT}; ` +
        `img-src 'self' data: blob: ${SOCIAL_MEDIA} ${CATALOG_MEDIA}; ` +
        `media-src 'self' blob: data: ${SOCIAL_MEDIA} ${CATALOG_MEDIA}; style-src 'self' 'unsafe-inline'; ` +
        "script-src 'self' 'unsafe-eval' 'unsafe-inline'; " +
        "worker-src 'self' blob:; " +
        "frame-src 'self'; child-src 'self'; frame-ancestors 'self'; object-src 'self'; base-uri 'self'; form-action 'self'",
    );
  });

  it("emits the exact directive set when Sentry is disabled (no ingest host at all)", async () => {
    const csp = await buildCspWithSentryEnabled(false);
    expect(csp).toBe(
      "default-src 'self'; " +
        "connect-src 'self' ws://127.0.0.1:* https://libi.nagellabs.com; " +
        `img-src 'self' data: blob: ${SOCIAL_MEDIA} ${CATALOG_MEDIA}; ` +
        `media-src 'self' blob: data: ${SOCIAL_MEDIA} ${CATALOG_MEDIA}; style-src 'self' 'unsafe-inline'; ` +
        "script-src 'self' 'unsafe-eval' 'unsafe-inline'; " +
        "worker-src 'self' blob:; " +
        "frame-src 'self'; child-src 'self'; frame-ancestors 'self'; object-src 'self'; base-uri 'self'; form-action 'self'",
    );
  });
});

describe("public templates catalog media", () => {
  /** Every source of one directive, as the browser tokenizes it. */
  const sources = (csp: string, name: string): string[] => {
    const directive = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.split(/\s+/)[0] === name);
    expect(directive, name).toBeDefined();
    return directive!.split(/\s+/).slice(1);
  };

  /** The pin: both buckets and nothing else under that host, in img-src and media-src — as a SET (source order means nothing to CSP). */
  const expectExactCatalogSources = (csp: string) => {
    for (const name of ["img-src", "media-src"]) {
      const googleSources = sources(csp, name).filter((s) => s.includes("storage.googleapis.com"));
      // Both buckets, nothing else under that host — a trailing slash
      // makes each a directory prefix, not one exact object.
      expect([...googleSources].sort(), name).toEqual([...CATALOG_SOURCES].sort());
    }
  };

  for (const sentry of [true, false]) {
    describe(`with Sentry ${sentry ? "enabled" : "disabled"}`, () => {
      it("admits exactly the two catalog bucket paths, with their trailing slash, in img-src and media-src", async () => {
        expectExactCatalogSources(await buildCspWithSentryEnabled(sentry));
      });

      it("never admits the bare storage.googleapis.com origin, in any directive", async () => {
        const csp = await buildCspWithSentryEnabled(sentry);
        // Every GCS bucket lives under that origin — an attacker's as much as
        // ours — so an origin-wide source would let any bucket's media render.
        for (const directive of csp.split(";").map((d) => d.trim())) {
          for (const source of directive.split(/\s+/).slice(1)) {
            if (!source.includes("storage.googleapis.com")) continue;
            expect(CATALOG_SOURCES, `${directive.split(/\s+/)[0]}: ${source}`).toContain(source);
          }
        }
        expect(csp).not.toMatch(/https:\/\/storage\.googleapis\.com(\/)?(;|\s|$)/);
        expect(csp).not.toContain("*.googleapis.com");
      });

      it("leaves connect-src and script-src exactly as they were — the bucket is shown, never fetched or run", async () => {
        const csp = await buildCspWithSentryEnabled(sentry);
        const connect = ["'self'", "ws://127.0.0.1:*", "https://libi.nagellabs.com", ...(sentry ? [SENTRY_CONNECT] : [])];
        expect(sources(csp, "connect-src")).toEqual(connect);
        expect(sources(csp, "script-src")).toEqual(["'self'", "'unsafe-eval'", "'unsafe-inline'"]);
      });
    });
  }

  // A12 review Minor 1: the pin must not care which order CATALOG_BUCKET_BASES lists its keys in.
  it("holds the exact-sources pin whatever order the bucket constants list their keys in", async () => {
    vi.resetModules();
    vi.doMock("@/lib/templates/cloud/constants", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/templates/cloud/constants")>();
      const reversed = Object.fromEntries(Object.entries(actual.CATALOG_BUCKET_BASES).reverse());
      return { ...actual, CATALOG_BUCKET_BASES: reversed };
    });
    try {
      const { buildCsp } = await import("@/lib/security/csp");
      expectExactCatalogSources(buildCsp());
    } finally {
      vi.doUnmock("@/lib/templates/cloud/constants");
    }
  });

  it("takes the bucket paths from the same constants the cloud client uses", async () => {
    // The pin above spells the paths out; this ties them to the one place the
    // client reads its bases from, so the two can never drift apart.
    expect(Object.values(CATALOG_BUCKET_BASES).sort()).toEqual([...CATALOG_SOURCES].sort());
    const csp = await buildCspWithSentryEnabled(false);
    for (const base of Object.values(CATALOG_BUCKET_BASES)) {
      expect(sources(csp, "img-src")).toContain(base);
      expect(sources(csp, "media-src")).toContain(base);
    }
  });
});
