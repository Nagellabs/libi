import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

// Pin the Sentry release to the package version so uploaded source maps and
// runtime events line up under one human-readable release (e.g. `libi@0.1.0`).
// `next build` runs from the repo root, so process.cwd() resolves package.json.
const libiVersion: string = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf8"),
).version;

const nextConfig: NextConfig = {
  // NO `output: "standalone"`. Nothing libi ships ever read it: both
  // production paths boot Next PROGRAMMATICALLY (`next({ dev: false, dir })`
  // — lib/server/next-server.ts for the packaged app, lib/cli/studio.ts for
  // `npx`), the npm tarball excluded `.next/standalone` (package.json#files)
  // and electron-builder never packed it. All the option did was copy a
  // 4.4GB deploy artifact into `.next/standalone` on every production build
  // (measured 2026-08: same build, ~30s → ~24s wall without it) — and Next
  // itself warned at packaged boot that "`next start` does not work with
  // `output: standalone`". Don't re-add it without a consumer that actually
  // boots `.next/standalone/server.js`.
  //
  // File TRACING still runs in every production build (the `.nft.json`
  // files) — standalone only controlled the copy step — so the excludes
  // below still apply: without them the tracer walks the repo into build
  // outputs (`release/` holds the previous build's .app/.dmg/.zip, ~3GB)
  // and traces them back into the graph.
  outputFileTracingExcludes: {
    "*": [
      "release/**",
      "dist-electron/**",
      "docs-local/**",
      ".next/dev/**",
    ],
  },
  // Next 16 ships a cross-origin guard that blocks dev-resource requests
  // (HMR socket, RSC payload, chunk preload) coming from hosts other than
  // the one Next started on. We bind on `localhost`, but the Electron main
  // window loads `http://127.0.0.1:${port}` (loopback by IP) and Playwright
  // E2E tests use 127.0.0.1 too — both are treated as cross-origin by Next.
  //
  // Symptom when this is missing: the page SSR HTML loads fine but React
  // never hydrates (no `__reactFiber$` on any DOM node, no API calls
  // ever fire, click handlers don't respond). The dev server logs:
  //   "Blocked cross-origin request to Next.js dev resource /_next/..."
  //
  // Allowing both loopback hostnames restores the dev runtime for Electron
  // and Playwright without disabling the guard for arbitrary origins.
  // This list is dev-only; production builds ignore it.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  experimental: {
    // The proxy (proxy.ts) makes Next clone every matched request body into
    // memory, capped at 10MB by default — beyond it the body is TRUNCATED and
    // multipart parsing 400s ("Request body exceeded 10MB…"). That silently
    // broke >10MB uploads and the chromium-render postback (the latter is now
    // also matcher-excluded — see proxy.ts). 2GB covers any realistic local
    // upload; memory cost is transient and proportional to the actual body.
    // NB: `middlewareClientMaxBodySize` (named in the runtime warning) is the
    // DEPRECATED alias of this option in this Next build.
    proxyClientMaxBodySize: "2gb",
  },
  // @napi-rs/canvas is a native addon (used by the tracking verify-render
  // route). It must stay external so Next.js require()s it at runtime and the
  // platform .node binding resolves from node_modules instead of being bundled.
  serverExternalPackages: [
    // OpenTelemetry's require/import interceptors, pulled in transitively by
    // @sentry/node (→ @opentelemetry/instrumentation). They monkey-patch the
    // module loader at runtime, so they must be require()d by their REAL name.
    //
    // Without this, Turbopack externalises them under a HASHED alias
    // (`require-in-the-middle-2ca7b9c2766f317e`) that resolves under `next dev`
    // — where the Turbopack runtime supplies the externals map — but NOT in a
    // packaged production build. The packaged app then dies at boot with:
    //
    //   Error: An error occurred while loading the instrumentation hook
    //     [cause]: Cannot find module 'require-in-the-middle-<hash>'
    //
    // …and never binds its port, despite the package being physically present
    // in node_modules. Found by running the first real `build:electron`.
    //
    // All three are promoted to direct `dependencies` in package.json (not
    // just externalised here) to pin their hoisted top-level location to the
    // SAME copy `@sentry/node` itself loads — that pin has to stay in
    // lockstep with whatever `@opentelemetry/instrumentation` range
    // `@sentry/node` requires, or npm can silently split the hoisted copy
    // from a nested `@sentry/node/node_modules/` one on a future `@sentry/node`
    // bump. `__tests__/unit/sentry/otel-instrumentation-lockstep.test.ts`
    // asserts our declared ranges still overlap what's actually installed —
    // update the range there, not just here, if it fails.
    "require-in-the-middle",
    "import-in-the-middle",
    "@opentelemetry/instrumentation",
    "better-sqlite3",
    "esbuild",
    "@napi-rs/canvas",
    // @resvg/resvg-js is a native addon (storyboard Tier-1 SVG/Satori → PNG,
    // run server-side via the storyboard watcher). Same rationale as
    // @napi-rs/canvas: keep external so the platform .node binding resolves
    // from node_modules at runtime instead of being bundled.
    "@resvg/resvg-js",
    // node-pty is a native addon (terminal sessions). Same rationale as
    // better-sqlite3: require() at runtime so the platform .node binding
    // resolves from node_modules instead of being bundled.
    "node-pty",
    // pino spawns a worker thread that loads pino-pretty by name. Turbopack's
    // production trace mangles the package name (`pino-28069d5257187539`) when
    // they're bundled, then the worker thread can't resolve it. Keep them
    // external so the standard Node resolver finds them in node_modules at
    // runtime.
    "pino",
    "pino-pretty",
    "next-logger",
  ],
  // NB: `electron` deliberately does NOT belong in `serverExternalPackages`.
  // Adding it makes Next's file tracing pull `node_modules/electron` into
  // `.next/standalone`, and `electron-builder` then dies packaging it:
  //   Error: ENOENT: no such file or directory, ensureSymlink '../../node_modules/electron'
  // (verified — it fails the `build:electron` MacPackager step outright). It
  // also doesn't help: Turbopack externalises it under a HASHED alias
  // (`electron-54412a2dc9f83256`) that does not exist at runtime. Server code
  // that needs Electron's main-process API resolves it through a runtime
  // `createRequire` instead — see `lib/install/npm-root.ts`.
};

// Wrap with Sentry to enable source-map upload (readable production stack
// traces). Org/project/auth-token are read from env — source maps upload only
// when SENTRY_AUTH_TOKEN (plus org + project) is set, so local/dev builds are
// unaffected. No `tunnelRoute`: this is an Electron desktop app, not a browser
// deploy, so ad-blocker bypass is irrelevant and a proxy route only adds surface.
export default withSentryConfig(nextConfig, {
  // Org/project slugs are not secret — committed as defaults so release builds
  // only need the secret SENTRY_AUTH_TOKEN. Override via env for a fork/staging.
  org: process.env.SENTRY_ORG || "nagellabs",
  project: process.env.SENTRY_PROJECT || "libi-editor",
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Tag this build's release (uploaded maps + runtime events) by version. Also
  // injected into the runtime bundle so events report the same release without
  // setting it in Sentry.init. Matching is further backed by embedded debug IDs.
  release: { name: `libi@${libiVersion}` },

  // Upload a wider set of client source files for better stack-trace resolution.
  widenClientFileUpload: true,

  // Suppress plugin output except in CI.
  silent: !process.env.CI,
});
