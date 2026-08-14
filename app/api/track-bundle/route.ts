import { NextResponse } from "next/server";
import path from "node:path";
import { build as esbuild } from "esbuild";
import { serverLogger as logger } from "@/lib/logger";

/**
 * Serves the browser-side tracking entry as a single JS bundle.
 *
 * Mirrors `/api/export/render-bundle` — see that file for the full rationale
 * behind bypassing the Next client bundle for headless-Playwright pages.
 */

let cachedBundle: string | null = null;
let cachedAt = 0;
const CACHE_TTL_MS =
  process.env.NODE_ENV === "production"
    ? 24 * 60 * 60 * 1000 // 1 day in prod
    : 5_000; // 5s in dev so edits to track-entry.ts pick up quickly

async function buildBundle(): Promise<string> {
  const entry = path.join(process.cwd(), "lib/tracking/track-entry.ts");
  const result = await esbuild({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome120"],
    write: false,
    sourcemap: "inline",
    logLevel: "silent",
    alias: { "@": path.join(process.cwd()) },
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
      logger.info(
        {
          event: "track_bundle_built",
          bytes: cachedBundle.length,
          durationMs: Date.now() - start,
        },
        "tracking.track_bundle_built",
      );
    } catch (err) {
      logger.error(
        { err, event: "track_bundle_build_failed" },
        "tracking.track_bundle_build_failed",
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
