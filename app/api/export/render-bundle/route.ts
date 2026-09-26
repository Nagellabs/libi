import { NextResponse } from "next/server";
import { createBundleCache } from "@/lib/bundles/browser-bundle";
import { exportLogger } from "@/lib/logger";

/**
 * Serves the browser-side render entry as a single JS bundle.
 *
 * We cannot reuse the Next.js client bundle for `/render` because
 * Next 16 dev mode (turbopack) does not reliably hydrate in headless
 * Playwright Chromium — the page loads, Turbopack chunks register,
 * but `app-next-turbopack.js` never completes its runtime module
 * instantiation, so no React effect ever fires. Bundling our render
 * entry with esbuild bypasses the Next client runtime entirely and
 * works in both dev and production.
 *
 * The esbuild configuration itself lives in `lib/bundles/browser-bundle.ts`,
 * shared with the overlay-sandbox runtime bundle — one classic-IIFE browser
 * build for every script libi serves outside Next's client runtime.
 *
 * The bundle is built once per process (cached in memory) and served
 * with long cache headers. A query param (`?v=`) can force a cache
 * bust if that's ever needed during development.
 */

const CACHE_TTL_MS = process.env.NODE_ENV === "production"
  ? 24 * 60 * 60 * 1000 // 1 day in prod — bundle is stable per deploy
  : 5_000;               // 5s in dev so edits to render-entry.ts pick up quickly
const cache = createBundleCache("lib/export/render-entry.ts", CACHE_TTL_MS);

/** The hash last logged as built, so a cache HIT stays silent — the event
 *  means "a build happened", as it did before the cache moved out of here. */
let lastLoggedHash: string | null = null;

export async function GET(): Promise<Response> {
  let code: string;
  try {
    const bundle = await cache.get();
    code = bundle.code;
    if (bundle.hash !== lastLoggedHash) {
      lastLoggedHash = bundle.hash;
      exportLogger.info(
        { event: "render_bundle_built", bytes: bundle.bytes, durationMs: bundle.durationMs },
        "export.render_bundle_built",
      );
    }
  } catch (err) {
    exportLogger.error(
      { err, event: "render_bundle_build_failed" },
      "export.render_bundle_build_failed",
    );
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
  return new Response(code, {
    status: 200,
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control":
        process.env.NODE_ENV === "production"
          ? "public, max-age=3600, immutable"
          : "no-cache",
    },
  });
}
