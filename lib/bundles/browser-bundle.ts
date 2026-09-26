import path from "node:path";
import { createHash } from "node:crypto";
import { build as esbuild } from "esbuild";

/**
 * One esbuild configuration for every standalone browser bundle libi serves
 * outside Next's client runtime: the export render entry (`/render`), the
 * overlay-sandbox supervisor and its worker. All are classic scripts (IIFE):
 * the sandbox worker MUST be classic — a module worker from a blob: URL does
 * not load at an opaque origin (spec A1) — and esbuild inlines `import("three")`
 * so no module specifier survives into the worker.
 */
export interface BrowserBundle {
  code: string;
  /** First 16 hex chars of the SHA-256 of `code` — the cache-busting `?v=`. */
  hash: string;
  bytes: number;
  durationMs: number;
}

export function hashBundleCode(code: string): string {
  return createHash("sha256").update(code).digest("hex").slice(0, 16);
}

export interface BrowserBundleOptions {
  /**
   * `"inline"` (the default) embeds the map in the served script, which is
   * worth its weight while debugging and roughly TRIPLES the bytes. The
   * overlay-sandbox bundles turn it off in production, where nothing reads it
   * and the worker's source is served a second time inside the supervisor's
   * script (`lib/sandbox/runtime-bundle.ts`).
   */
  sourcemap?: "inline" | false;
}

export async function buildBrowserBundle(
  entryRelPath: string,
  options: BrowserBundleOptions = {},
): Promise<BrowserBundle> {
  const start = Date.now();
  const result = await esbuild({
    entryPoints: [path.join(process.cwd(), entryRelPath)],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome120"],
    write: false,
    sourcemap: options.sourcemap ?? "inline",
    logLevel: "silent",
    // Mirror the tsconfig path alias so "@/..." resolves as it does in the app.
    alias: { "@": path.join(process.cwd()) },
    // Strip server-only branches if any sneak in via shared modules.
    define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development") },
  });
  const code = result.outputFiles[0]!.text;
  return { code, hash: hashBundleCode(code), bytes: code.length, durationMs: Date.now() - start };
}

/** Build once per `ttlMs` (a day in production, seconds in dev so edits show). */
export function createBundleCache(
  entryRelPath: string,
  ttlMs: number,
  options: BrowserBundleOptions = {},
): { get(): Promise<BrowserBundle> } {
  let cached: BrowserBundle | null = null;
  let builtAt = 0;
  let inFlight: Promise<BrowserBundle> | null = null;
  return {
    async get() {
      const now = Date.now();
      if (cached && now - builtAt <= ttlMs) return cached;
      if (!inFlight) {
        inFlight = buildBrowserBundle(entryRelPath, options).then(
          (b) => {
            cached = b;
            builtAt = Date.now();
            inFlight = null;
            return b;
          },
          (err) => {
            inFlight = null;
            throw err;
          },
        );
      }
      return inFlight;
    },
  };
}
