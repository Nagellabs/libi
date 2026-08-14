#!/usr/bin/env node
// Production Next build for DISTRIBUTED artifacts (packaged Electron, and any
// release where end users should get error tracking out of the box).
//
// Bakes NEXT_PUBLIC_LIBI_SENTRY=1 into the client + server bundles so the
// packaged app reports to Sentry without a runtime .env. The DSN itself is the
// committed public default in lib/sentry/config.ts. A plain `next build`
// (npm run build) intentionally leaves the flag unset → Sentry stays off, so
// local production builds don't report to the shared project.
//
// Cross-platform replacement for an inline `VAR=value next build`.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { readFileSync } = fs;
const path = require("node:path");
const { writeExternalsManifest } = require("./write-next-externals-manifest.js");
const { buildCli, assertCliBundleFresh } = require("./build-cli.js");

const ROOT = path.resolve(__dirname, "..");

// Start from an empty `.next`. This is the RELEASE path — the artifact users
// receive — so reproducibility beats incremental-build speed, and inheriting
// whatever a previous `npm run dev` left behind is exactly how a release build
// stops describing its own commit.
//
// 2026-08-14, the first real `npm publish`: `.next` held a Turbopack `cache/`
// from Jul 28, a `dev/` from a dev-server run hours earlier, and partial output
// from an interrupted build. `next build` then failed inside the Google-fonts
// loader with a completely misdirecting error — "Can't resolve
// '@vercel/turbopack-next/internal/font/google/font' … next/font/google queries
// have exactly one entry", tracing to app/layout.tsx's Fraunces import. Nothing
// was wrong with the font config; `rm -rf .next` fixed it outright.
//
// `npm run build` (the dev-facing production build) deliberately does NOT do
// this — incremental is the right default there.
if (fs.existsSync(path.join(ROOT, ".next"))) {
  fs.rmSync(path.join(ROOT, ".next"), { recursive: true, force: true });
  console.log("[next-build-release] cleared .next — release builds start cold, never from a dev cache.");
}

// Org + project slugs are committed defaults in next.config.ts, so the only
// thing this build still needs for source-map upload is the secret auth token.
// If it's missing we DON'T fail the build (capture still works) — but we emit a
// loud warning so whoever runs the release build on this machine remembers to
// set it; otherwise production stack traces stay minified in Sentry.
//
// Read `.env.sentry-build-plugin` before deciding what to print. The Sentry
// build plugin loads that file ITSELF, so judging by `process.env` alone made
// this message untrue in both directions — it could announce "DISABLED" while
// maps uploaded fine, or the reverse. On 2026-08-14 the truth had to be
// established afterwards by querying Sentry's artifact-bundle API, and even
// then the timestamps were ambiguous. A release log that cannot be trusted
// about its own artifacts is worse than no log.
if (!process.env.SENTRY_AUTH_TOKEN) {
  try {
    const envFile = readFileSync(path.join(ROOT, ".env.sentry-build-plugin"), "utf-8");
    const match = envFile.match(/^\s*SENTRY_AUTH_TOKEN\s*=\s*(.+?)\s*$/m);
    if (match && match[1]) {
      process.env.SENTRY_AUTH_TOKEN = match[1];
      console.log(
        "[next-build-release] SENTRY_AUTH_TOKEN read from .env.sentry-build-plugin (the file the plugin itself loads).",
      );
    }
  } catch {
    // Absent is the normal case outside a release machine — say nothing.
  }
}
if (process.env.SENTRY_AUTH_TOKEN) {
  console.log(
    "[next-build-release] Sentry source-map upload: ENABLED (maps will upload, tagged by release).",
  );
} else {
  console.warn(
    "\n⚠️  [next-build-release] Sentry source-map upload is DISABLED for this build.\n" +
      "   Missing env var: SENTRY_AUTH_TOKEN\n" +
      "   → Production stack traces in Sentry will stay MINIFIED.\n" +
      "   Set it on the build machine (release env / CI secret) to upload maps:\n" +
      "     SENTRY_AUTH_TOKEN=<token>   (SECRET — .env.sentry-build-plugin or CI, never commit)\n" +
      "   (org=nagellabs, project=libi-editor are committed defaults; override via SENTRY_ORG / SENTRY_PROJECT.)\n",
  );
}

const env = { ...process.env, NEXT_PUBLIC_LIBI_SENTRY: "1" };

// Mirror the hard kill-switch under a NEXT_PUBLIC_ name so it is baked into the
// CLIENT bundle too. Only NEXT_PUBLIC_*-prefixed vars are exposed to client
// code, so a build made with LIBI_SENTRY_DISABLED=1 would otherwise still ship
// a reporting renderer. lib/sentry/config.ts honours either name. Note this is
// build-time: for a PACKAGED app, the renderer's copy is fixed here, so set the
// var on the build if you want a permanently non-reporting artifact.
if (env.LIBI_SENTRY_DISABLED === "1" && env.NEXT_PUBLIC_LIBI_SENTRY_DISABLED === undefined) {
  env.NEXT_PUBLIC_LIBI_SENTRY_DISABLED = "1";
  console.log(
    "[next-build-release] LIBI_SENTRY_DISABLED=1 detected — mirroring to NEXT_PUBLIC_LIBI_SENTRY_DISABLED so the client bundle is gated too.",
  );
}
const result = spawnSync("npx", ["next", "build"], {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

// Record Turbopack's `.next/node_modules` externals symlink farm as a plain
// JSON manifest — npm strips symlinks from every tarball, so this file is the
// ONLY way a consumer's install can rebuild the farm at boot. Without it the
// installed server binds its port and 500s every route.
//
// This is the RELEASE build path (`build:electron` → publish / package), so it
// must not be able to skip the writer. It is chained explicitly rather than via
// an npm `postbuild` hook because npm only fires pre/post hooks for scripts it
// runs by NAME, and this file is invoked as `node scripts/next-build-release.js`
// from inside another script — no hook would fire. `npm run build` chains the
// same writer in package.json.
try {
  const { manifestPath, buildId, count } = writeExternalsManifest();
  console.log(
    `[next-build-release] recorded ${count} externals symlink(s) for build ${buildId} -> ${manifestPath}`,
  );
} catch (err) {
  console.error(
    `\n❌ [next-build-release] failed to write the Next.js externals manifest: ${err && err.message ? err.message : err}\n` +
      "   A build without it produces a server that starts and then 500s every route.\n",
  );
  process.exit(1);
}

// Compile the CLI + MCP entry chains to `dist-cli/`. `npx @nagellabs/libi`
// cannot launch without them: tsx refuses to apply tsconfig `paths` to any
// file under a `node_modules` segment, so every `@/…` import in an installed
// copy throws MODULE_NOT_FOUND before a line of libi runs (see
// scripts/build-cli.js).
//
// Called EXPLICITLY here, and chained by name in package.json's `prepack`.
// Not an npm lifecycle hook — same reason spelled out above for the externals
// manifest: `build:electron` invokes this file BY PATH, and npm only fires
// pre/post hooks for scripts it runs by NAME. That is the exact trap that let
// the externals-manifest writer silently never run.
(async () => {
  try {
    const { fileCount, outDir } = await buildCli();
    assertCliBundleFresh();
    console.log(`[next-build-release] compiled ${fileCount} CLI/MCP file(s) -> ${outDir}`);
  } catch (err) {
    console.error(
      `\n❌ [next-build-release] failed to compile the CLI/MCP entry chains: ${err && err.message ? err.message : err}\n` +
        "   Without dist-cli/, `npx @nagellabs/libi` cannot start at all.\n",
    );
    process.exit(1);
  }
  process.exit(0);
})();
