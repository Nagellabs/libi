import { NextResponse } from "next/server";
import path from "node:path";
import { build as esbuild } from "esbuild";
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
 * The bundle is built once per process (cached in memory) and served
 * with long cache headers. A query param (`?v=`) can force a cache
 * bust if that's ever needed during development.
 */

let cachedBundle: string | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = process.env.NODE_ENV === "production"
  ? 24 * 60 * 60 * 1000 // 1 day in prod — bundle is stable per deploy
  : 5_000;               // 5s in dev so edits to render-entry.ts pick up quickly

async function buildBundle(): Promise<string> {
  const entry = path.join(process.cwd(), "lib/export/render-entry.ts");
  const result = await esbuild({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome120"],
    write: false,
    sourcemap: "inline",
    logLevel: "silent",
    // Mirror the tsconfig path aliases so "@/..." imports resolve the same
    // way as they do for the app code.
    alias: { "@": path.join(process.cwd()) },
    // Strip server-only branches if any sneak in via shared modules.
    define: {
      "process.env.NODE_ENV": JSON.stringify(
        process.env.NODE_ENV ?? "development",
      ),
    },
  });
  return result.outputFiles[0]!.text;
}

export async function GET(): Promise<Response> {
  const now = Date.now();
  if (!cachedBundle || now - cachedAt > CACHE_TTL_MS) {
    const start = now;
    try {
      cachedBundle = await buildBundle();
      cachedAt = Date.now();
      exportLogger.info(
        { event: "render_bundle_built", bytes: cachedBundle.length, durationMs: Date.now() - start },
        "export.render_bundle_built",
      );
    } catch (err) {
      exportLogger.error(
        { err, event: "render_bundle_build_failed" },
        "export.render_bundle_build_failed",
      );
      return NextResponse.json(
        { error: (err as Error).message },
        { status: 500 },
      );
    }
  }
  return new Response(cachedBundle, {
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
