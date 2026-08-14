/**
 * Server-side face/object tracker that drives a headless Playwright Chromium.
 *
 * Why Playwright: `@mediapipe/tasks-vision` requires a real WebGL canvas, which
 * plain Node cannot provide. Reusing the same Chromium binary the canvas-export
 * pipeline already depends on lets us run MediaPipe in-browser without pulling
 * in heavy native deps.
 *
 * Flow:
 *   1. Create a track job in the registry (yields jobId + token + done promise).
 *   2. Launch (or reuse) the cached Chromium browser.
 *   3. Open `/track?jobId=…&token=…` — the page bootstraps the MediaPipe
 *      bundle, loads the video by URL, seeks frame-by-frame, runs detection,
 *      and POSTs results to `/api/tracks/result`.
 *   4. Await the registry promise. The result is { samples, framerate }.
 *
 * The caller (Task 3.2) is responsible for constructing `fileUrl` — typically
 * `http://127.0.0.1:${port}/api/files/by-id/${fileId}/content`.
 */
import type { Browser } from "playwright-core";
import { createTrackJob } from "@/lib/tracking/track-jobs";
import { serverLogger as logger } from "@/lib/logger";
import { getCurrentPort } from "@/lib/libi-home";
import type { Anchor, LibiTrackConfig, TrackSample } from "@/lib/tracking/types";

export interface FaceTrackerOpts {
  fps: number;
  // TODO(task-10-followup): remove `subjectQuery` field — replaced by `anchors`
  // in Task 8/10 but still threaded through the runner payload. Removable in a
  // mechanical cleanup pass (4 files touched).
  subjectQuery?: string;
  /** URL the browser will load the video from. */
  fileUrl: string;
  /** Source file id (used for logging / dedupe). */
  fileId: string;
  /** Piece scope for the registry (not used for storage here). */
  pieceId: string;
  /**
   * Reference frames identifying the subject. Forwarded to the in-browser
   * tracker which uses them to compute Face Landmarker fingerprints for the
   * per-frame identity gate.
   */
  anchors?: Anchor[];
  /** JobManager id — surfaced to the page so debugging logs can correlate. */
  jobId?: string;
  /** Frame index to resume from on a re-run. Defaults to 0. */
  startFrame?: number;
  /** Samples emitted in a prior run (resume only). */
  priorSamples?: TrackSample[];
  /**
   * Called from inside the page each time the tracker advances. The runner
   * forwards to `JobContext.reportProgress`. `msPerFrame` is reserved for
   * future per-frame timing; current callers omit it.
   */
  onProgress?: (done: number, total: number, msPerFrame?: number) => void;
  /**
   * Persist resume state. The page invokes this every ~90 frames or right
   * before bailing out on cancel.
   */
  onCheckpoint?: (state: { framesDone: number; partialSamples: TrackSample[] }) => Promise<void>;
  /** Polled by the page at progress emit boundaries to bail out cleanly. */
  shouldCancel?: () => boolean;
}

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    const { chromium } = await import("playwright-core");
    try {
      const browser = await chromium.launch({
        headless: true,
        channel: "chromium",
        args: ["--enable-features=OpenH264SoftwareEncoder", "--use-gl=swiftshader"],
      });
      browser.on("disconnected", () => {
        browserPromise = null;
      });
      return browser;
    } catch (err) {
      browserPromise = null;
      const message = err instanceof Error ? err.message : String(err);
      if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
        throw new Error(
          "Playwright Chromium not found. Run 'npx playwright install chromium'.",
        );
      }
      throw err;
    }
  })();
  return browserPromise;
}

export async function runFaceTracker(
  opts: FaceTrackerOpts,
): Promise<{ samples: TrackSample[]; framerate: number }> {
  return runTracker({ ...opts, objectKind: "face" });
}

export async function runObjectTracker(
  opts: FaceTrackerOpts,
): Promise<{ samples: TrackSample[]; framerate: number }> {
  return runTracker({ ...opts, objectKind: "object" });
}

async function runTracker(
  opts: FaceTrackerOpts & { objectKind: "face" | "object" },
): Promise<{ samples: TrackSample[]; framerate: number }> {
  logger.info(
    { fileId: opts.fileId, fps: opts.fps, kind: opts.objectKind },
    "tracking.start",
  );

  const job = createTrackJob({
    pieceId: opts.pieceId,
    payload: {
      fileId: opts.fileId,
      fileUrl: opts.fileUrl,
      fps: opts.fps,
      objectKind: opts.objectKind,
      subjectQuery: opts.subjectQuery,
    },
  });

  const browser = await getBrowser();
  const page = await browser.newPage();
  const port = getCurrentPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const url = `${baseUrl}/track?jobId=${encodeURIComponent(job.jobId)}&token=${encodeURIComponent(job.token)}`;

  // Expose JobContext callbacks to the page. These become globally-callable
  // async functions inside Chromium — track-entry uses them as
  // `window.__libiReportProgress`, `__libiCheckpoint`, `__libiShouldCancel`.
  // MUST happen before navigation (addInitScript runs on document_start).
  await page.exposeFunction(
    "__libiReportProgress",
    (done: number, total: number, ms?: number) => {
      opts.onProgress?.(done, total, ms);
    },
  );
  await page.exposeFunction(
    "__libiCheckpoint",
    async (state: { framesDone: number; partialSamples: unknown }) => {
      await opts.onCheckpoint?.(
        state as { framesDone: number; partialSamples: TrackSample[] },
      );
    },
  );
  await page.exposeFunction("__libiShouldCancel", () =>
    Boolean(opts.shouldCancel?.()),
  );

  // Inject locally-served MediaPipe asset root + anchors + resume state BEFORE
  // the entry bundle runs. track-entry.ts reads `window.__libiTrackConfig` to
  // resolve wasm / Face Landmarker model URLs (against /api/models/[...path]),
  // run the fingerprint identity gate when anchors are present, and resume from
  // `startFrame` with `priorSamples` already accumulated.
  await page.addInitScript(
    (cfg: LibiTrackConfig) => {
      (
        window as unknown as {
          __libiTrackConfig: LibiTrackConfig;
        }
      ).__libiTrackConfig = cfg;
    },
    {
      modelBaseUrl: `${baseUrl}/api/models`,
      anchors: opts.anchors,
      jobId: opts.jobId,
      startFrame: opts.startFrame,
      priorSamples: opts.priorSamples,
    } satisfies LibiTrackConfig,
  );

  page.on("console", (msg) =>
    logger.info(
      { jobId: job.jobId, level: msg.type(), text: msg.text() },
      "tracking.console",
    ),
  );
  page.on("pageerror", (err) =>
    logger.warn(
      { jobId: job.jobId, error: err.message, stack: err.stack },
      "tracking.pageerror",
    ),
  );

  try {
    await page.goto(url, { waitUntil: "load" });
    const result = await job.done;
    logger.info(
      { fileId: opts.fileId, sampleCount: result.samples.length },
      "tracking.done",
    );
    return { samples: result.samples, framerate: result.framerate };
  } finally {
    if (!page.isClosed()) await page.close().catch(() => {});
  }
}
