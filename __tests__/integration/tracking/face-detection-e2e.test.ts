import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type Browser } from "playwright-core";
import { tryLaunchChromium } from "@/__tests__/helpers/playwright-browser";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { build as esbuild } from "esbuild";
import { hasFaceFixture, FIXTURE_SKIP_REASON } from "./fixture-guard";

const FIXTURE = path.join(
  process.cwd(),
  "__tests__/fixtures/tracking/non-selfie-face-5s.mp4",
);
const MODEL_ROOT = path.join(
  process.env.HOME ?? "",
  ".libi/models",
);

// Per `lib/tracking/face-detection.ts`, modelBaseUrl is prefixed onto
// `/mediapipe-vision/wasm` and `/mediapipe-vision/models/*`, so we serve
// `~/.libi/models/` as the root.

function fixtureMissing(): string | null {
  if (!fs.existsSync(FIXTURE)) return `fixture missing: ${FIXTURE}`;
  if (!fs.existsSync(path.join(MODEL_ROOT, "mediapipe-vision/models/face_landmarker.task"))) {
    return "mediapipe models not installed — run libi once or `npx libi install`";
  }
  if (!fs.existsSync(path.join(MODEL_ROOT, "mediapipe-vision/models/blaze_face_short_range.tflite"))) {
    return "blaze_face_short_range.tflite not installed";
  }
  return null;
}

// Set when the Playwright browser binary isn't installed — the suite then
// skips with that reason instead of failing in beforeAll.
let launchFailure: string | null = null;

/** The single skip gate every test consults: fixtures first, then the browser. */
function skipReason(): string | null {
  return fixtureMissing() ?? launchFailure;
}

let browser: Browser | null = null;
let server: http.Server | null = null;
let port = 0;
let bundleJs = "";

beforeAll(async () => {
  if (fixtureMissing()) return; // skip path; assertions in tests guard.

  // Bundle test-entry.ts using the same esbuild config the production
  // /api/track-bundle route uses — keeps the bundle behavior identical.
  const built = await esbuild({
    entryPoints: [path.join(process.cwd(), "lib/tracking/test-entry.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome120"],
    write: false,
    sourcemap: "inline",
    logLevel: "silent",
    absWorkingDir: process.cwd(),
    tsconfig: path.join(process.cwd(), "tsconfig.json"),
  });
  bundleJs = built.outputFiles[0].text;

  // Tiny http server serving the bundle, the fixture, and the model tree.
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/bundle.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(bundleJs);
      return;
    }
    if (u.pathname === "/fixture.mp4") {
      res.writeHead(200, { "content-type": "video/mp4" });
      fs.createReadStream(FIXTURE).pipe(res);
      return;
    }
    if (u.pathname.startsWith("/models/")) {
      const rel = u.pathname.replace(/^\/models\//, "");
      const fp = path.join(MODEL_ROOT, rel);
      if (!fs.existsSync(fp)) { res.writeHead(404).end(); return; }
      const ext = path.extname(fp).toLowerCase();
      const mime =
        ext === ".wasm" ? "application/wasm" :
        ext === ".js" ? "application/javascript" :
        "application/octet-stream";
      res.writeHead(200, { "content-type": mime });
      fs.createReadStream(fp).pipe(res);
      return;
    }
    if (u.pathname === "/page.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><meta charset="utf-8"></head>
<body><script src="/bundle.js"></script></body></html>`);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  port = (server!.address() as { port: number }).port;

  const launched = await tryLaunchChromium({
    headless: true,
    channel: "chromium",
    args: [
      "--use-gl=swiftshader",
      // Without these, paused off-screen <video> in headless Chromium freezes on
      // frame 0 — seeked fires but the compositor never presents the new frame
      // to drawImage/texImage2D, so MediaPipe keeps reading frame 0.
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-media-suspend",
      "--disable-features=AutoplayIgnoreWebAudio,MediaPlaybackPower,IntensiveWakeUpThrottling",
    ],
  });
  browser = launched.browser;
  launchFailure = launched.skipReason;
}, 120_000);

afterAll(async () => {
  if (browser) await browser.close();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});

if (!hasFaceFixture) console.info(`[skip] ${FIXTURE_SKIP_REASON}`);

describe.skipIf(!hasFaceFixture)("face-detection two-stage pipeline (e2e via Playwright)", () => {
  it("detects faces with anchor hints (Path A) — anchor crop succeeds where full-frame FaceLandmarker fails", async () => {
    const skip = skipReason();
    if (skip) { console.warn("SKIP:", skip); return; }
    if (!browser) throw new Error("browser not initialized");

    const page = await browser.newPage();
    try {
      page.on("console", (m) => console.log("[browser]", m.type(), m.text()));
      await page.goto(`http://127.0.0.1:${port}/page.html`);
      await page.waitForFunction(
        () => Boolean((window as unknown as { __libiFaceDetectionTest?: unknown }).__libiFaceDetectionTest),
        { timeout: 30_000 },
      );

      // 5-second clip → frames at t=0, 1, 2, 3, 4. The fixture is a segment in
      // which a single performer's face is visible the entire time. Hints are
      // coarse — tuned by hand against that clip, so they travel with it.
      const probes = [
        { t: 0.0, hint: { x: 800, y: 200, w: 380, h: 380 } },
        { t: 1.0, hint: { x: 800, y: 220, w: 380, h: 380 } },
        { t: 2.0, hint: { x: 800, y: 240, w: 380, h: 380 } },
        { t: 3.0, hint: { x: 800, y: 260, w: 380, h: 380 } },
        { t: 4.0, hint: { x: 800, y: 280, w: 380, h: 380 } },
      ];

      const out = (await page.evaluate(
        async (args) =>
          await (window as unknown as {
            __libiFaceDetectionTest: { run: (a: unknown) => Promise<unknown> };
          }).__libiFaceDetectionTest.run(args),
        {
          modelBaseUrl: `http://127.0.0.1:${port}/models`,
          videoUrl: `http://127.0.0.1:${port}/fixture.mp4`,
          probes,
        },
      )) as Array<{
        t: number;
        result: null | { source: string; fingerprintGeometryLen: number; fingerprintBlendshapeLen: number; bbox: { x: number; y: number; w: number; h: number } };
      }>;

      console.log("probe results:", JSON.stringify(out, null, 2));

      // Strong assertion: at least 4 of 5 hinted probes should succeed.
      const successes = out.filter((r) => r.result !== null);
      expect(successes.length).toBeGreaterThanOrEqual(4);

      // Each success must be a "hint"-sourced detection (Path A) — proves
      // we're not silently relying on the BlazeFace fallback.
      for (const s of successes) {
        expect(s.result!.source).toBe("hint");
        expect(s.result!.fingerprintGeometryLen).toBeGreaterThan(0);
        expect(s.result!.fingerprintBlendshapeLen).toBeGreaterThan(0);
        // Bbox must intersect the original frame (not negative-only).
        expect(s.result!.bbox.w).toBeGreaterThan(50);
        expect(s.result!.bbox.h).toBeGreaterThan(50);
      }
    } finally {
      await page.close();
    }
  }, 120_000);

  it("detects faces without hints (Path B) — BlazeFace seeds the crop", async () => {
    const skip = skipReason();
    if (skip) { console.warn("SKIP:", skip); return; }
    if (!browser) throw new Error("browser not initialized");

    const page = await browser.newPage();
    try {
      page.on("console", (m) => console.log("[browser]", m.type(), m.text()));
      await page.goto(`http://127.0.0.1:${port}/page.html`);
      await page.waitForFunction(
        () => Boolean((window as unknown as { __libiFaceDetectionTest?: unknown }).__libiFaceDetectionTest),
        { timeout: 30_000 },
      );

      // No hints — exercises the BlazeFace fallback exclusively. The fixture
      // is a music-video segment with a scene cut at ~2s (wagon-scene wide
      // shot → road close-up); BlazeFace short-range only reliably finds the
      // face in the close-up half (≥0.6 confidence). Probe the close-up
      // window so the fallback path is exercised against the scene class it
      // was designed for.
      const probes = [
        { t: 2.5, hint: null },
        { t: 3.0, hint: null },
        { t: 4.0, hint: null },
      ];
      const out = (await page.evaluate(
        async (args) =>
          await (window as unknown as {
            __libiFaceDetectionTest: { run: (a: unknown) => Promise<unknown> };
          }).__libiFaceDetectionTest.run(args),
        {
          modelBaseUrl: `http://127.0.0.1:${port}/models`,
          videoUrl: `http://127.0.0.1:${port}/fixture.mp4`,
          probes,
        },
      )) as Array<{ result: null | { source: string } }>;

      console.log("blaze-fallback results:", JSON.stringify(out, null, 2));

      const successes = out.filter((r) => r.result !== null);
      // All 3 should succeed via BlazeFace fallback.
      expect(successes.length).toBe(3);
      for (const s of successes) {
        expect(s.result!.source).toBe("blazeface");
      }
    } finally {
      await page.close();
    }
  }, 120_000);
});
