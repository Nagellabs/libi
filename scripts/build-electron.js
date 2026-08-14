#!/usr/bin/env node
/**
 * Bundle the Electron main + preload to dist-electron/electron/ using
 * esbuild.
 *
 * Why esbuild instead of `tsc -p electron/tsconfig.json`:
 *  - tsc-alias mis-rewrites `require("electron")` to `require("../electron")`
 *    because the local `electron/` directory shadows the npm package at
 *    the baseUrl. Bundling sidesteps the issue: esbuild resolves imports
 *    via the standard Node algorithm + an explicit `external` list.
 *  - We do NOT want to type-check the entire libi tree on every Electron
 *    rebuild; type checking is owned by the main `npm run build` pipeline.
 *
 * Externals: anything that resolves through native Node addons or that
 * Electron requires at runtime stays external. Everything else gets
 * bundled into main.js / preload.js so a packaged Electron app doesn't
 * need to navigate the source tree.
 */

const path = require("node:path");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "dist-electron", "electron");

fs.mkdirSync(OUT_DIR, { recursive: true });

/**
 * Packages that must remain external. `electron` is provided by the
 * runtime; `next` and `better-sqlite3` (and friends) pull in native
 * binaries / `.node` files that esbuild can't safely inline. We list
 * the broad set explicitly rather than relying on packageJson "external"
 * heuristics.
 */
const EXTERNALS = [
  "electron",
  "next",
  "next/*",
  "react",
  "react-dom",
  "better-sqlite3",
  "drizzle-orm",
  "drizzle-orm/*",
  "pino",
  "pino-pretty",
  // Sentry's Node SDK pulls in the OpenTelemetry tree; keep it a runtime
  // require (resolved from node_modules) rather than inlining it into main.js.
  "@sentry/node",
  "@sentry/node/*",
  "next-logger",
  "next-themes",
  "ora",
  "playwright-core",
  "esbuild",
  "@napi-rs/canvas",
  "@mediapipe/tasks-vision",
  "@elevenlabs/elevenlabs-js",
  "@agentclientprotocol/sdk",
  // Nothing in electron/main.ts's import graph imports this today (verified
  // via grep) — the Claude ACP adapter is only ever spawned as a subprocess
  // binary (lib/agents/acp/agent-registry.ts), never `require()`d, and it's
  // a devDependency, excluded from the packaged app (electron-builder.yml)
  // and installed at runtime instead (lib/agents/runtime-install.ts). Kept
  // here as a deliberate tripwire rather than removed: if some future import
  // DOES reach this package, leaving it external means esbuild emits a bare
  // `require("@agentclientprotocol/claude-agent-acp")` that resolves in dev
  // (the devDependency is on disk there) and throws MODULE_NOT_FOUND in the
  // packaged app — a loud, fail-fast crash. Removing the entry instead would
  // let esbuild silently inline the package (and the ~212MB proprietary
  // Anthropic SDK behind it) straight into main.js, defeating the whole
  // point of excluding it and shipping proprietary code with no distribution
  // licence, undetected by both the license gate (which scans node_modules,
  // not bundled JS) and electron-builder.yml's node_modules exclusion.
  "@agentclientprotocol/claude-agent-acp",
  "@zed-industries/codex-acp",
  "@modelcontextprotocol/sdk",
  "@modelcontextprotocol/sdk/*",
];

async function buildEntry(entry, outFile) {
  await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile: path.join(OUT_DIR, outFile),
    external: EXTERNALS,
    sourcemap: true,
    logLevel: "info",
    tsconfig: path.join(ROOT, "electron", "tsconfig.json"),
    // Resolve `@/foo` from the repo root, same as Next.js does.
    alias: {},
    resolveExtensions: [".ts", ".tsx", ".mjs", ".js"],
    absWorkingDir: ROOT,
    define: {
      "process.env.NODE_ENV": JSON.stringify(
        process.env.NODE_ENV || "production",
      ),
    },
    // Esbuild reads `paths` from tsconfig automatically for `@/*` style
    // aliases, but only when the `tsconfig` option is set — done above.
  });
  console.log("[build-electron] built " + outFile);
}

(async () => {
  try {
    await Promise.all([
      buildEntry("electron/main.ts", "main.js"),
      buildEntry("electron/preload.ts", "preload.js"),
      buildEntry("electron/splash-preload.ts", "splash-preload.js"),
    ]);
    fs.copyFileSync(
      path.join(ROOT, "electron", "splash.html"),
      path.join(OUT_DIR, "splash.html"),
    );
    console.log("[build-electron] OK");
  } catch (err) {
    console.error("[build-electron] FAIL:", err);
    process.exit(1);
  }
})();
