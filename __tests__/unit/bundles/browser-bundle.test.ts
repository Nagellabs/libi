import { describe, it, expect } from "vitest";
import { buildBrowserBundle, createBundleCache } from "@/lib/bundles/browser-bundle";
import { getOverlayRuntimeBundle, getOverlayWorkerBundle } from "@/lib/sandbox/runtime-bundle";

describe("buildBrowserBundle", () => {
  it("bundles the worker entry to a classic IIFE with a content hash and no server code", async () => {
    const b = await buildBrowserBundle("lib/sandbox/runtime-entry.ts");
    expect(b.code.length).toBeGreaterThan(100);
    expect(b.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(b.bytes).toBe(b.code.length);
    expect(b.code).not.toContain("node:fs");
  }, 30_000);

  it("caches by TTL", async () => {
    const cache = createBundleCache("lib/sandbox/runtime-entry.ts", 60_000);
    const a = await cache.get();
    const b = await cache.get();
    expect(b).toBe(a);
  }, 30_000);
});

describe("overlay runtime bundles (A1: classic worker, absolute specifiers)", () => {
  it("the worker bundle is a classic script: no runtime import() or importScripts() left in it", async () => {
    const w = await getOverlayWorkerBundle();
    // esbuild inlines `import("three")` into the IIFE; a surviving dynamic
    // import would need an ABSOLUTE specifier (the worker's base URL is its
    // blob: URL) and would be a bug here.
    //
    // The worker DOES legitimately contain the string `/\bimport\s*\(/`: it is
    // the draw-body denylist's own entry (lib/ai/scene-validator.ts) — a regex
    // LITERAL and the label beside it, neither of them a call. Strip exactly
    // those two strings before looking, rather than loosening the check.
    const DENYLIST_IMPORT_ENTRY = [String.raw`/\bimport\s*\(/`, "dynamic import()"];
    for (const literal of DENYLIST_IMPORT_ENTRY) expect(w.code.includes(literal)).toBe(true);
    const code = DENYLIST_IMPORT_ENTRY.reduce((acc, literal) => acc.split(literal).join("«denylist»"), w.code);
    expect(code).not.toMatch(/\bimport\s*\(/);
    expect(code).not.toMatch(/\bimportScripts\s*\(/);
    expect(code).not.toMatch(/\bexport\s+(default|const|function|class)\b/);
  }, 30_000);
  it("the runtime bundle is the supervisor with the worker source embedded as a JSON string, hashed together", async () => {
    const [w, r] = await Promise.all([getOverlayWorkerBundle(), getOverlayRuntimeBundle()]);
    expect(r.code.startsWith("const __LIBI_WORKER_SOURCE__ = \"")).toBe(true);
    expect(r.code).toContain(JSON.stringify(w.code));
    expect(r.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(r.hash).not.toBe(w.hash);
  }, 30_000);
});

/**
 * Size pins (Task 4 review ruling). Measured WITHOUT the sourcemap, which is
 * what production serves: an inline map is ~3× the code and is a dev-only
 * affordance. The ceilings are binary (MiB/KiB); the numbers they guard are the
 * reason the supervisor leg carries no zod (`lib/sandbox/protocol-supervisor.ts`)
 * — with it the supervisor bundle was 553 KB, and the served runtime bundle
 * pays for the supervisor AND the worker, since the worker rides inside it as a
 * string.
 */
const WORKER_BUNDLE_MAX_BYTES = 2.5 * 1024 * 1024;
const SUPERVISOR_BUNDLE_MAX_BYTES = 200 * 1024;

describe("overlay runtime bundle size (no sourcemap — what production serves)", () => {
  it("the worker bundle stays under its ceiling with three.js inlined", async () => {
    const w = await buildBrowserBundle("lib/sandbox/runtime-entry.ts", { sourcemap: false });
    expect(w.code.includes("//# sourceMappingURL")).toBe(false);
    // three.js IS in there — a pin that passed because the import vanished
    // would be worthless.
    expect(w.code.includes("WebGLRenderer")).toBe(true);
    expect(w.bytes).toBeLessThanOrEqual(WORKER_BUNDLE_MAX_BYTES);
  }, 60_000);
  it("the supervisor bundle stays tiny: it validates one two-command union and must not carry zod", async () => {
    const s = await buildBrowserBundle("lib/sandbox/supervisor-entry.ts", { sourcemap: false });
    expect(s.bytes).toBeLessThanOrEqual(SUPERVISOR_BUNDLE_MAX_BYTES);
    expect(s.code.includes("ZodError")).toBe(false);
  }, 60_000);
  it("keeps the inline sourcemap when one is asked for (the dev default)", async () => {
    const s = await buildBrowserBundle("lib/sandbox/supervisor-entry.ts");
    expect(s.code.includes("//# sourceMappingURL=data:application/json;base64,")).toBe(true);
  }, 60_000);
});

/**
 * The export's render page is an esbuild IIFE with no `process` global. Task 10
 * put the overlay sandbox's iframe transport in it, which once reached
 * `lib/security/csp.ts` for a path constant — and csp.ts reads `process.env`
 * at module scope (Sentry, social). The page would have thrown on load before
 * drawing a frame; `lib/sandbox/paths.ts` is the leaf that keeps it out.
 */
describe("the render page bundle (/api/export/render-bundle)", () => {
  it("embeds the overlay sandbox host and reads no process.env at runtime", async () => {
    const b = await buildBrowserBundle("lib/export/render-entry.ts", { sourcemap: false });
    expect(b.code).toContain("/sandbox/overlay-runtime");
    // Any form — `.X`, `[X]`, a destructure — not only property access.
    expect(b.code).not.toMatch(/\bprocess\.env\b/);
  }, 60_000);

  /**
   * Gate h3 by construction (Task 10 review, minor 6): no code path in the
   * render page can compile an overlay body, because the compiler is not in the
   * page at all. It used to ride in with `createSharedThreeRenderer`, which
   * shared a module with `buildThreeInstance` → `compileThreeBody` → `new
   * Function`; the renderer now lives in the compiler-free leaf
   * `lib/engine/three-renderer.ts`. The bundle is unminified, so the names
   * survive into it — and the positive control proves they would be seen.
   *
   * Custom EFFECT bodies too (human-publish fix round 1, C1): the page holds
   * curve-backed defs and the effect sandbox's host; `createAnimateFunction`
   * and `sampleEffectCurve`, which compile and call an `animate.js`, are not in
   * it at all.
   */
  it("carries no overlay-body compiler: body code can only run in the sandbox", async () => {
    const b = await buildBrowserBundle("lib/export/render-entry.ts", { sourcemap: false });
    expect(b.code).toContain("createSharedThreeRenderer"); // names do survive bundling
    expect(b.code).toContain("EffectSampler"); // the effect sandbox's host is here
    for (const compiler of ["compileDrawBody", "compileThreeBody", "buildThreeInstance", "createDrawFunction", "validateThreeFunction", "LayerEngine", "createAnimateFunction", "sampleEffectCurve"]) {
      expect(b.code.includes(compiler), compiler).toBe(false);
    }
  }, 60_000);
});
