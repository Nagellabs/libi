import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { build as esbuild } from "esbuild";
import { type Browser } from "playwright-core";
import { tryLaunchChromium } from "@/__tests__/helpers/playwright-browser";
import { hasFaceFixture, FIXTURE_SKIP_REASON } from "./fixture-guard";

const FIXTURE = path.join(
  process.cwd(),
  "__tests__/fixtures/tracking/non-selfie-face-5s.mp4",
);
const MODEL_ROOT = path.join(process.env.HOME ?? "", ".libi/models");

function missing(): string | null {
  if (!fs.existsSync(FIXTURE)) return `fixture missing: ${FIXTURE}`;
  if (!fs.existsSync(path.join(MODEL_ROOT, "mediapipe-vision/models/face_landmarker.task")))
    return "mediapipe models not installed";
  if (!fs.existsSync(path.join(MODEL_ROOT, "mediapipe-vision/models/blaze_face_short_range.tflite")))
    return "blaze_face_short_range.tflite not installed";
  return null;
}

// Set when the Playwright browser binary isn't installed — the suite then
// skips with that reason instead of failing in beforeAll.
let launchFailure: string | null = null;

/** The single skip gate every test consults: fixtures first, then the browser. */
function skipReason(): string | null {
  return missing() ?? launchFailure;
}

let browser: Browser | null = null;
let server: http.Server | null = null;
let port = 0;

// Shared state for the route handlers + assertions.
const JOB: { jobId: string; token: string; payload: unknown } = {
  jobId: "test-job-1",
  token: "test-token",
  payload: null,
};
let resolvedResult: { samples: unknown[]; framerate: number; method: string } | null = null;
let resolvedError: string | null = null;

beforeAll(async () => {
  if (missing()) return;

  // Bundle the PRODUCTION track-entry — same esbuild config /api/track-bundle uses.
  const built = await esbuild({
    entryPoints: [path.join(process.cwd(), "lib/tracking/track-entry.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome120"],
    write: false,
    sourcemap: "inline",
    logLevel: "silent",
    absWorkingDir: process.cwd(),
    alias: { "@": process.cwd() },
    tsconfig: path.join(process.cwd(), "tsconfig.json"),
  });
  const bundleJs = built.outputFiles[0].text;
  console.log("[e2e-setup] bundle built, bytes:", bundleJs.length);

  // The /track page shape mirrors app/track/route.ts.
  const trackHtml = (jobId: string, token: string) =>
    `<!doctype html><html><body>
<pre id="status"></pre>
<video id="video" muted playsinline crossorigin="anonymous"></video>
<script>${bundleJs}</script>
<script>
  window.__libiTrack.runTrack({
    jobId: ${JSON.stringify(jobId)},
    token: ${JSON.stringify(token)},
  });
</script></body></html>`;

  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");

    if (u.pathname === "/track") {
      const jid = u.searchParams.get("jobId") ?? "";
      const tok = u.searchParams.get("token") ?? "";
      res.writeHead(200, { "content-type": "text/html" });
      res.end(trackHtml(jid, tok));
      return;
    }

    if (u.pathname.startsWith("/api/tracks/job/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jobId: JOB.jobId, payload: JOB.payload }));
      return;
    }

    if (u.pathname === "/api/tracks/result") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body) as {
            samples: unknown[]; framerate: number; method: string;
          };
          resolvedResult = { samples: parsed.samples, framerate: parsed.framerate, method: parsed.method };
        } catch (e) {
          resolvedError = String(e);
        }
        res.writeHead(200).end();
      });
      return;
    }

    if (u.pathname === "/api/tracks/error") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try { resolvedError = JSON.parse(body).message; } catch { resolvedError = body; }
        res.writeHead(200).end();
      });
      return;
    }

    if (u.pathname.startsWith("/api/models/")) {
      const rel = u.pathname.replace(/^\/api\/models\//, "");
      const fp = path.join(MODEL_ROOT, rel);
      if (!fs.existsSync(fp)) { res.writeHead(404).end(); return; }
      const ext = path.extname(fp).toLowerCase();
      const mime = ext === ".wasm" ? "application/wasm"
        : ext === ".js" ? "application/javascript"
        : "application/octet-stream";
      res.writeHead(200, { "content-type": mime });
      fs.createReadStream(fp).pipe(res);
      return;
    }

    if (u.pathname === "/fixture.mp4") {
      res.writeHead(200, { "content-type": "video/mp4" });
      fs.createReadStream(FIXTURE).pipe(res);
      return;
    }

    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  port = (server!.address() as { port: number }).port;

  // Match the production mediapipe-runner.ts launch args.
  const launched = await tryLaunchChromium({
    headless: true,
    channel: "chromium",
    args: ["--enable-features=OpenH264SoftwareEncoder", "--use-gl=swiftshader"],
  });
  browser = launched.browser;
  launchFailure = launched.skipReason;
}, 120_000);

afterAll(async () => {
  if (browser) await browser.close();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});

if (!hasFaceFixture) console.info(`[skip] ${FIXTURE_SKIP_REASON}`);

describe.skipIf(!hasFaceFixture)("runFaceTracker full pipeline (production track-entry bundle)", () => {
  it("emits visible:true samples on the non-selfie fixture", async () => {
    const skip = skipReason();
    if (skip) { console.warn("SKIP:", skip); return; }
    if (!browser) throw new Error("browser not initialized");

    JOB.payload = {
      fileId: "fixture",
      fileUrl: `http://127.0.0.1:${port}/fixture.mp4`,
      fps: 5, // 5 fps × 5s = 25 frames; keep the test fast.
      objectKind: "face",
    };
    resolvedResult = null;
    resolvedError = null;

    const page = await browser.newPage();
    try {
      page.on("console", (m) => console.log("[browser]", m.type(), m.text()));
      page.on("pageerror", (e) => console.log("[pageerror]", e.message));

      // Inject __libiTrackConfig — mediapipe-runner.ts does this in production
      // via addInitScript before navigation.
      await page.addInitScript(
        (cfg) => {
          (window as unknown as { __libiTrackConfig: unknown }).__libiTrackConfig = cfg;
        },
        {
          modelBaseUrl: `http://127.0.0.1:${port}/api/models`,
          anchors: [
            // Anchor times sit in the close-up half of the fixture (clip t≥2)
            // where the face is dominant — gives BlazeFace + FaceLandmarker
            // a clean shot.
            { fileId: "fixture", time: 2.5, bbox: [800, 240, 380, 380] },
            { fileId: "fixture", time: 3.5, bbox: [800, 260, 380, 380] },
          ],
        },
      );

      await page.goto(
        `http://127.0.0.1:${port}/track?jobId=${encodeURIComponent(JOB.jobId)}&token=${encodeURIComponent(JOB.token)}`,
      );

      // Wait for either /result or /error to fire.
      const deadline = Date.now() + 90_000;
      while (!resolvedResult && !resolvedError && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
      if (resolvedError) throw new Error(`track-entry posted error: ${resolvedError}`);
      expect(resolvedResult).not.toBeNull();
      const r = resolvedResult!;

      // 25 frames @ 5 fps for 5 sec.
      expect(r.samples.length).toBeGreaterThanOrEqual(20);
      const visible = (r.samples as Array<{ visible: boolean }>).filter((s) => s.visible);
      // ≥ 50% of frames produce a visible (fingerprint-gated) sample.
      // This is looser than face-detection-e2e's ≥80% to account for
      // headless Chromium frame-stepping quirks in this end-to-end path.
      // The KEY signal is non-zero, not perfect coverage — face-detection-e2e
      // proves the helper is solid; here we prove the production wiring works.
      expect(visible.length).toBeGreaterThanOrEqual(Math.floor(r.samples.length * 0.5));
      expect(r.method).toBe("mediapipe-face");
    } finally {
      await page.close();
    }
  }, 120_000);
});
