import type { RenderDriver } from "./types";
import { getRenderJobTokenByJobId, rejectRenderJob } from "@/lib/export/render-jobs";
import { waitForRenderJobSettlement } from "./settle-wait";
import { exportLogger } from "@/lib/logger";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Browser } from "playwright-core";

// The page outlives the registry entry by a small grace, and is torn down
// promptly once the entry settles. The driver waits for a page close/crash OR
// for the registry entry to settle (resolve on success, reject on stall/cap) —
// then holds the page open for a short grace so any in-flight postback/logging
// completes before teardown. This replaces the old fixed hard cap that lingered
// a full extra minute after a timeout.
const GRACE_MS = 5_000;

export type RenderMode = "gpu" | "software";

/**
 * The per-platform ANGLE backend for GPU-mode headless rendering. Each value is
 * the backend Chromium/ANGLE documents as that platform's native default, so we
 * pin the most-likely-to-activate hardware path:
 *
 *   - darwin  → `metal`  — the only ANGLE GPU backend on macOS; EMPIRICALLY
 *                verified (~18× on Apple Silicon, `scripts/gpu-render-probe.ts`,
 *                docs-local/webcodecs-matrix.md "Headless GPU").
 *   - win32   → `d3d11`  — ANGLE's documented Windows default ("ANGLE defaults
 *                to D3D11 where it's available"); the standard GPU path on
 *                Windows. NOT yet empirically verified (no Windows host).
 *   - linux   → `gl`     — ANGLE's documented Linux default (Desktop GL). Chosen
 *                over `vulkan` because it needs no Vulkan driver/ICD install and
 *                is the broadest-compat GPU path; a Vulkan-equipped host can opt
 *                in via LIBI_RENDER_ANGLE_BACKEND (below). NOT yet empirically
 *                verified (no Linux GPU host).
 *
 * Sources: Chromium `docs/gpu/using-gpu-hardware-in-headless-chrome.md`
 * (Linux `--enable-gpu` autodetect + `--use-angle=vulkan` fallback) and the
 * ANGLE README platform-backend table (Windows→D3D11 default, Linux→Desktop GL,
 * macOS→Metal).
 *
 * Non-darwin backends land safely: if the flag is rejected the launch throws →
 * software fallback; if it launches but yields a software rasterizer the
 * renderer probe detects it → software fallback. So an unverified backend can
 * only ever degrade to the legacy path, never break the export.
 */
const ANGLE_BACKEND_BY_PLATFORM: Record<string, string> = {
  darwin: "metal",
  win32: "d3d11",
  linux: "gl",
};

/** Fallback ANGLE backend for platforms not in the map (e.g. freebsd). */
const DEFAULT_ANGLE_BACKEND = "gl";

/**
 * The only env var these builders read. The index signature keeps
 * `process.env` (NodeJS.ProcessEnv) assignable while letting tests pass a bare
 * `{}` or `{ LIBI_RENDER_ANGLE_BACKEND: "…" }` without a full env object.
 */
type AngleEnv = { LIBI_RENDER_ANGLE_BACKEND?: string; [key: string]: string | undefined };

/**
 * Resolve the ANGLE backend for GPU mode on a given platform. An operator can
 * override per host via `LIBI_RENDER_ANGLE_BACKEND` (e.g. `vulkan` on a Linux
 * box with Vulkan drivers, or `d3d9` on legacy Windows) — the override is not
 * validated here because an invalid backend simply fails the GPU launch and
 * falls back to software, same as any other unsupported flag.
 */
export function resolveAngleBackend(
  platform: string = process.platform,
  env: AngleEnv = process.env,
): string {
  const override = env.LIBI_RENDER_ANGLE_BACKEND?.trim();
  if (override) return override;
  return ANGLE_BACKEND_BY_PLATFORM[platform] ?? DEFAULT_ANGLE_BACKEND;
}

/**
 * Pure builder for the Chromium launch args by render mode.
 *
 * - `"software"` returns EXACTLY the legacy flags (SwiftShader software GL +
 *   software H.264 via OpenH264). This is the historical behavior and the
 *   guaranteed-portable fallback — platform-independent.
 * - `"gpu"` returns the GPU flag set with the per-platform ANGLE backend
 *   (`resolveAngleBackend`): `--enable-gpu` + the platform's native ANGLE
 *   backend + `--ignore-gpu-blocklist` (headless/server GPUs are often
 *   blocklisted) + the OpenH264 software-encoder feature so H.264 encode still
 *   works if the hardware encoder is unavailable (Chrome falls back
 *   transparently). `platform`/`env` are injectable for testing.
 */
export function buildLaunchArgs(
  mode: RenderMode,
  platform: string = process.platform,
  env: AngleEnv = process.env,
): string[] {
  if (mode === "software") {
    return ["--enable-features=OpenH264SoftwareEncoder", "--use-gl=swiftshader"];
  }
  return [
    "--enable-gpu",
    `--use-angle=${resolveAngleBackend(platform, env)}`,
    "--ignore-gpu-blocklist",
    "--enable-features=OpenH264SoftwareEncoder",
  ];
}

/**
 * True when the WebGL `UNMASKED_RENDERER_WEBGL` string denotes a software
 * rasterizer (SwiftShader / generic software / llvmpipe). The driver gates the
 * GPU→software fallback on THIS alone — hardware encode is logged but not gated.
 */
export function isSoftwareRenderer(s: string): boolean {
  return /swiftshader|software|llvmpipe/i.test(s);
}

// Minimal secure-context probe page. WebGL `WEBGL_debug_renderer_info` gives the
// unmasked renderer; `VideoEncoder.isConfigSupported` needs a secure context
// (file:// qualifies — about:blank / data: do NOT; see docs-local/webcodecs-matrix.md).
const PROBE_HTML = `<!doctype html>
<html><body><canvas id="c" width="64" height="64"></canvas><script>
(async () => {
  const out = { renderer: "", hwEncode: false };
  try {
    const cv = document.getElementById("c");
    const gl = cv.getContext("webgl2") || cv.getContext("webgl");
    if (gl) {
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      out.renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    }
    if (typeof VideoEncoder !== "undefined") {
      try {
        const r = await VideoEncoder.isConfigSupported({
          codec: "avc1.640028", width: 1920, height: 1080,
          bitrate: 8000000, framerate: 30, hardwareAcceleration: "prefer-hardware",
        });
        out.hwEncode = r.supported === true;
      } catch (e) { /* leave hwEncode false */ }
    }
  } catch (e) { out.error = String(e); }
  window.__libiProbe = out;
  window.__libiProbeDone = true;
})();
</script></body></html>`;

type CachedBrowser = {
  browser: Browser;
  mode: RenderMode;
  renderer: string;
  hwEncode: boolean;
};

let browserPromise: Promise<CachedBrowser> | null = null;

async function launchChromium(mode: RenderMode): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  try {
    return await chromium.launch({
      headless: true,
      // channel: "chromium" forces the FULL Chromium build. The default
      // (headless: true without channel) launches chrome-headless-shell, which
      // ships WITHOUT WebCodecs. Verified via scripts/webcodecs-probe.ts — see
      // docs-local/webcodecs-matrix.md.
      channel: "chromium",
      args: buildLaunchArgs(mode),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
      throw new Error(
        "Playwright Chromium not found. Run 'npx playwright install chromium' to enable canvas-scene exports in this runtime.",
      );
    }
    throw err;
  }
}

// If the browser crashes / is killed externally (SIGKILL, OOM) or the connection
// is lost, clear the cache so the next getBrowser() call relaunches instead of
// handing out a dead Browser handle.
function attachDisconnect(browser: Browser) {
  browser.on("disconnected", () => {
    browserPromise = null;
  });
}

// Launch a throwaway page against the file:// probe and read back the renderer
// string + hardware-encode support. A throwing/timed-out probe returns an
// "unknown" renderer so the caller keeps the GPU launch (we only fall back on a
// POSITIVELY-software renderer, never on an indeterminate probe).
async function probeBrowser(browser: Browser): Promise<{ renderer: string; hwEncode: boolean }> {
  const htmlPath = join(tmpdir(), `libi-render-probe-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(htmlPath, PROBE_HTML, "utf8");
  const page = await browser.newPage();
  try {
    await page.goto("file://" + htmlPath);
    await page.waitForFunction(
      () => (window as unknown as { __libiProbeDone?: boolean }).__libiProbeDone === true,
      null,
      { timeout: 15_000 },
    );
    const result = (await page.evaluate(
      () => (window as unknown as { __libiProbe?: { renderer?: string; hwEncode?: boolean } }).__libiProbe,
    )) as { renderer?: string; hwEncode?: boolean } | undefined;
    return { renderer: String(result?.renderer ?? ""), hwEncode: result?.hwEncode === true };
  } finally {
    await page.close().catch(() => {});
    try { unlinkSync(htmlPath); } catch { /* best-effort temp cleanup */ }
  }
}

async function getBrowser(): Promise<CachedBrowser> {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    // Rollback lever: force the legacy software path, skip the probe entirely.
    if (process.env.LIBI_RENDER_FORCE_SOFTWARE === "1") {
      const browser = await launchChromium("software");
      attachDisconnect(browser);
      const cached: CachedBrowser = { browser, mode: "software", renderer: "forced-software", hwEncode: false };
      exportLogger.info(
        { event: "render_gpu_mode", mode: cached.mode, renderer: cached.renderer, hwEncode: cached.hwEncode, forced: true },
        "export.render_gpu_mode",
      );
      return cached;
    }

    // GPU-first: launch with GPU flags, probe the renderer, fall back to software
    // ONLY when the renderer is positively software.
    let browser: Browser;
    try {
      browser = await launchChromium("gpu");
    } catch (err) {
      // The GPU-flagged launch itself failed (a GPU flag rejected on this host).
      // Fall back to the guaranteed-portable software flags. A genuinely missing
      // executable fails BOTH launches, so the install hint still propagates from
      // the software attempt.
      exportLogger.warn(
        { event: "render_gpu_launch_failed", error: err instanceof Error ? err.message : String(err) },
        "export.render_gpu_launch_failed",
      );
      browser = await launchChromium("software");
      attachDisconnect(browser);
      const cached: CachedBrowser = { browser, mode: "software", renderer: "gpu-launch-failed", hwEncode: false };
      exportLogger.info(
        { event: "render_gpu_mode", mode: cached.mode, renderer: cached.renderer, hwEncode: cached.hwEncode, fellBack: true },
        "export.render_gpu_mode",
      );
      return cached;
    }

    let renderer = "unknown";
    let hwEncode = false;
    try {
      const probe = await probeBrowser(browser);
      renderer = probe.renderer || "unknown";
      hwEncode = probe.hwEncode;
    } catch (err) {
      exportLogger.warn(
        { event: "render_probe_failed", error: err instanceof Error ? err.message : String(err) },
        "export.render_probe_failed",
      );
    }

    if (isSoftwareRenderer(renderer)) {
      // GPU flags landed on a software rasterizer — relaunch with the legacy
      // software flags for a known-good path. Close the throwaway GPU browser
      // first (no disconnect handler attached to it, so this won't null the cache).
      await browser.close().catch(() => {});
      browser = await launchChromium("software");
      attachDisconnect(browser);
      const cached: CachedBrowser = { browser, mode: "software", renderer, hwEncode: false };
      exportLogger.info(
        { event: "render_gpu_mode", mode: cached.mode, renderer: cached.renderer, hwEncode: cached.hwEncode, fellBack: true },
        "export.render_gpu_mode",
      );
      return cached;
    }

    attachDisconnect(browser);
    const cached: CachedBrowser = { browser, mode: "gpu", renderer, hwEncode };
    exportLogger.info(
      { event: "render_gpu_mode", mode: cached.mode, renderer: cached.renderer, hwEncode: cached.hwEncode },
      "export.render_gpu_mode",
    );
    return cached;
  })().catch((err) => {
    // A rejected launch must NOT stay cached — a single transient Chromium
    // launch failure would otherwise brick every later export until restart.
    // Null the cache so the next getBrowser() retries a fresh launch; concurrent
    // callers of this in-flight launch still share (and see the failure of) it.
    browserPromise = null;
    throw err;
  });
  return browserPromise;
}

export const playwrightDriver: RenderDriver = {
  name: "playwright",
  // Resolve the active render mode by ensuring the cached browser (via the
  // single-flight getBrowser()) and returning the mode it already tracked from
  // the launch + probe. Cheap after the first call — the browser is cached.
  async renderMode(): Promise<RenderMode> {
    const { mode } = await getBrowser();
    return mode;
  },
  async runJob({ jobId, port }) {
    const entry = getRenderJobTokenByJobId(jobId);
    if (!entry) throw new Error(`No registry entry for job ${jobId}`);

    const { browser, mode } = await getBrowser();
    const page = await browser.newPage();
    const url = `http://127.0.0.1:${port}/render?jobId=${encodeURIComponent(jobId)}&token=${encodeURIComponent(entry.token)}`;

    exportLogger.info({ event: "playwright_page_open", jobId, renderMode: mode }, "export.playwright_page_open");

    // Forward browser console + page errors to the server log so we can diagnose
    // render-page failures that would otherwise be silent.
    page.on("console", (msg) => {
      exportLogger.info(
        { event: "playwright_console", jobId, level: msg.type(), text: msg.text() },
        "export.playwright_console",
      );
    });
    page.on("pageerror", (err) => {
      exportLogger.warn(
        { event: "playwright_page_error", jobId, error: err.message, stack: err.stack },
        "export.playwright_page_error",
      );
    });
    page.on("requestfailed", (req) => {
      exportLogger.warn(
        { event: "playwright_request_failed", jobId, url: req.url(), failure: req.failure()?.errorText },
        "export.playwright_request_failed",
      );
    });

    let graceTimer: NodeJS.Timeout | undefined;
    // If page close/crash wins the race, the finally runs while the settlement
    // promise is still pending; when it later resolves it must NOT arm a stray
    // grace timer after teardown. `raceDone` guards that ordering.
    let raceDone = false;
    try {
      await page.goto(url, { waitUntil: "load" });
      // The caller (ChromiumRenderBackend) awaits the registry promise; this driver
      // just has to keep the page alive until the render + postback completes, then
      // tear it down promptly once the registry entry settles.
      await Promise.race([
        new Promise<void>((resolve) => {
          // "close" is the normal success teardown; "crash" is a renderer death
          // that will never POST a result back. Reject the registry entry
          // immediately on crash so `handle.done` fails now instead of hanging
          // until the stall watchdog / absolute cap fires. rejectRenderJob is
          // idempotent on already-settled entries, so a crash after a successful
          // settlement is a safe no-op.
          page.on("crash", () => {
            rejectRenderJob(jobId, entry.token, "render page crashed");
            resolve();
          });
          page.on("close", () => resolve());
        }),
        waitForRenderJobSettlement(jobId).then(
          () => new Promise<void>((resolve) => {
            if (raceDone) { resolve(); return; }
            graceTimer = setTimeout(resolve, GRACE_MS);
          }),
        ),
      ]);
    } finally {
      raceDone = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (!page.isClosed()) {
        await page.close().catch(() => {});
      }
      exportLogger.info({ event: "playwright_page_close", jobId }, "export.playwright_page_close");
    }
  },
  async shutdown() {
    if (browserPromise) {
      const { browser } = await browserPromise;
      browserPromise = null;
      await browser.close().catch(() => {});
      exportLogger.info({ event: "playwright_shutdown" }, "export.playwright_shutdown");
    }
  },
};
