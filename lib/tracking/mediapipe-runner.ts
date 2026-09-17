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
import { ensureChromium } from "@/lib/export/ensure-chromium";
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
  /**
   * Chromium itself is installed on demand too. When the first
   * tracker run on a machine has to fetch it, its byte progress arrives here
   * so the job can report an honest "87/173 MB" phase before the frames.
   */
  onDownloadProgress?: (p: { doneMb: number; totalMb: number }) => void;
  /**
   * Called `true` when a first-use dependency install starts and `false` when
   * it ends. The tracking job runner maps it to `ctx.pauseWatchdog()`: its
   * 60 s no-progress watchdog is tuned to per-frame ticks, while this phase is
   * a 33 MB model fetch that reports nothing plus a 173 MB Chromium download
   * whose installer emits one line per 10 % — well over 60 s apart on a slow
   * link. Without it the watchdog killed the tracker and called it a tracking
   * failure.
   */
  onDependencyPhase?: (active: boolean) => void;
}

/**
 * The launch in flight, if any. Every caller — including the one whose call
 * started it — is a PARTICIPANT, with its own progress sink, its own
 * dependency-phase bracket and its own cancel; the child is only cancelled
 * once the last one has left.
 *
 * It used to be a bare `Promise<Browser>`: a second caller got the first
 * caller's browser and NONE of its callbacks. That silently broke the thing
 * `onDependencyPhase` exists for — a tracker that JOINED an in-flight
 * 173 MB Chromium fetch never learned a dependency phase was running, so it
 * never paused its 60 s no-progress watchdog and was killed mid-download and
 * reported to the user as a tracking failure.
 *
 * ## How two callers get in here at once — corrected
 *
 * Commit 650748f4's message justified this change with two claims that do not
 * survive reading the code, and they are restated here only to retire them:
 * that "the queue hands the second job over the moment the first finishes"
 * (with `maxConcurrent: 1`, on the happy path it cannot — job 1 is still
 * inside `getBrowser`), and that "the export driver reaches the same browser
 * from a third direction" (it does not: `lib/export/drivers/playwright.ts`
 * keeps its own private `browserPromise` and never imports this module).
 *
 * The real overlap is narrower and a STRONGER argument for participants:
 * `lib/jobs/manager.ts` races the runner against the abort signal
 * (`Promise.race`, ~:561), so a cancelled or watchdog-tripped job 1 is
 * reported terminal while its runner keeps running, orphaned — still holding
 * the flight. `maxConcurrent: 1` then admits job 2, which joins that same
 * flight. That is precisely the case a shared promise with one caller's
 * callbacks handles wrongly and participants handle correctly: job 1's
 * cancellation must not kill job 2's download, and job 2 must inherit the
 * dependency-phase bracket it arrived in the middle of.
 *
 * Same treatment `ensureChromium` was given one layer up and,
 * deliberately, the same shape — see `joinInFlight` there.
 */
interface BrowserFlight {
  /** Settled by `runBrowserFlight`; every participant awaits it through its
   *  own promise so one caller's cancel cannot reject the others. */
  settled: Promise<Browser>;
  resolve: (b: Browser) => void;
  reject: (e: Error) => void;
  participants: Set<Participant>;
  /** True between the phase opening and closing, so a joiner arriving MID
   *  install is told to suspend its watchdog too — the whole defect. */
  depPhaseActive: boolean;
  /** Replayed to a late joiner so its bar is not blank until the next 10 % step. */
  lastProgress: { doneMb: number; totalMb: number } | null;
}

interface Participant {
  opts: GetBrowserOpts;
}

let browserFlight: BrowserFlight | null = null;

export interface GetBrowserOpts {
  onDownloadProgress?: FaceTrackerOpts["onDownloadProgress"];
  onDependencyPhase?: FaceTrackerOpts["onDependencyPhase"];
  shouldCancel?: () => boolean;
}

function newBrowserFlight(): BrowserFlight {
  let resolve!: (b: Browser) => void;
  let reject!: (e: Error) => void;
  const settled = new Promise<Browser>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Every participant can detach, so nobody may be left holding this one.
  // Each still gets the real error through its own promise.
  settled.catch(() => {});
  return { settled, resolve, reject, participants: new Set(), depPhaseActive: false, lastProgress: null };
}

function emitDependencyPhase(flight: BrowserFlight, active: boolean): void {
  flight.depPhaseActive = active;
  for (const p of flight.participants) p.opts.onDependencyPhase?.(active);
}

function emitDownloadProgress(
  flight: BrowserFlight,
  progress: { doneMb: number; totalMb: number },
): void {
  flight.lastProgress = progress;
  for (const p of flight.participants) p.opts.onDownloadProgress?.(progress);
}

/**
 * Attach one caller to a flight: its callbacks, its cancellation, its promise.
 * The caller that STARTED the flight goes through here too — before the body
 * runs — so there is no owner.
 */
function joinBrowserFlight(flight: BrowserFlight, opts: GetBrowserOpts): Promise<Browser> {
  const me: Participant = { opts };
  flight.participants.add(me);
  // Catch a joiner up on state it missed. The phase replay is the load-bearing
  // one: without it a tracker joining a download in progress runs its watchdog
  // against an install that reports nothing.
  if (flight.depPhaseActive) opts.onDependencyPhase?.(true);
  // Only while the phase is OPEN. A successful flight is deliberately not
  // cleared (it doubles as the browser cache), so `lastProgress` outlives the
  // install that produced it — and every later joiner in the process is a
  // tracking job that never downloaded anything. Unguarded, this replayed
  // "173 / 173 MB" into `reportProgress` (lib/jobs/runners/tracking.ts:178)
  // before the frame counter started: a download that is not happening,
  // reported outside any dependency phase. `ensureChromium` cannot have this
  // bug because it nulls its `inFlight` in a `finally`.
  if (flight.depPhaseActive && flight.lastProgress) {
    opts.onDownloadProgress?.(flight.lastProgress);
  }
  return new Promise<Browser>((resolve, reject) => {
    let done = false;
    const finish = (err: Error | null, browser?: Browser) => {
      if (done) return;
      done = true;
      clearInterval(cancelPoll);
      flight.participants.delete(me);
      if (err) reject(err);
      else resolve(browser as Browser);
    };
    const cancelPoll = setInterval(() => {
      if (!opts.shouldCancel?.()) return;
      // Detach only THIS caller. The install carries on for whoever is left,
      // and `runBrowserFlight`'s `shouldCancel` — "is anyone still waiting" —
      // goes true only when the set empties. A cancel used to kill the shared
      // download and fail every other waiter (the same asymmetry, one layer up).
      // Re-arm my own watchdog on the way out: `emitDependencyPhase(false)`
      // will no longer reach me.
      if (flight.depPhaseActive) opts.onDependencyPhase?.(false);
      finish(new Error("browser launch cancelled"));
    }, 500);
    cancelPoll.unref?.();
    flight.settled.then(
      (browser) => finish(null, browser),
      (err: Error) => finish(err),
    );
  });
}

async function runBrowserFlight(flight: BrowserFlight): Promise<void> {
  try {
    // The wasm + model assets moved to tier-2 (2026-09-08) so they no longer
    // cost 33 MB at every boot. That makes their absence a normal state the
    // tracker must repair, not an error: `ensureDep` installs exactly this dep
    // when it is missing (writing the same dependencyStatus transitions the
    // Settings chips poll, so the agent path and the human path stay one
    // install) and is a pure no-op when the assets are already on disk —
    // NOT `retryDep`, which always re-downloads and so cost 33 MB per tracker
    // start and failed offline.
    // Both installs are wrapped as ONE dependency phase — see
    // `FaceTrackerOpts.onDependencyPhase`. The `finally` matters as much as
    // the call: a failed install must re-arm every participant's watchdog, not
    // leave it suspended for the rest of the job.
    emitDependencyPhase(flight, true);
    try {
      const { DependencyManager } = await import("@/mcp/registry/dependency-manager");
      await new DependencyManager().ensureDep("libi-tracking", "mediapipe-vision");
      // The browser is the export's dependency (`libi-export` / chromium),
      // shared by the tracker; same streamed install, same Settings chip. A
      // no-op once it is on disk.
      await ensureChromium({
        // Not any one caller's handle: the download is cancelled only when
        // every participant has detached (each one's own `shouldCancel` is
        // polled in `joinBrowserFlight`).
        shouldCancel: () => flight.participants.size === 0,
        onProgress: (p) => emitDownloadProgress(flight, p),
      });
    } finally {
      emitDependencyPhase(flight, false);
    }
    const { chromium } = await import("playwright-core");
    let browser: Browser;
    try {
      browser = await chromium.launch({
        headless: true,
        channel: "chromium",
        args: ["--enable-features=OpenH264SoftwareEncoder", "--use-gl=swiftshader"],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
        // ensureChromium verified the executable a moment ago, so this is a
        // broken install, not a missing one: point at the Re-download action
        // the `installed` chip shows (a forced reinstall).
        throw new Error(
          "Playwright Chromium failed to launch after install. Use Re-download on the chromium dependency under Settings → Canvas export (Chromium) to replace it.",
        );
      }
      throw err;
    }
    browser.on("disconnected", () => {
      if (browserFlight === flight) browserFlight = null;
    });
    flight.resolve(browser);
  } catch (err) {
    // A FAILED flight must not be cached. It used to be: a rejection from the
    // install half (a cancelled Chromium download, an offline model fetch)
    // left a permanently-rejected promise here, so every later tracker start
    // in the process re-threw that same error without retrying anything.
    if (browserFlight === flight) browserFlight = null;
    flight.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/** Exported for tests — the tracker itself only reaches it through `runTracker`.
 *  Single-flight with participant semantics: a concurrent caller shares the
 *  launch already running AND receives its dependency-phase bracket and its
 *  download progress. */
export function getBrowser(opts: GetBrowserOpts = {}): Promise<Browser> {
  const existing = browserFlight;
  if (existing) return joinBrowserFlight(existing, opts);
  const flight = newBrowserFlight();
  browserFlight = flight;
  // Registered BEFORE the body runs: `runBrowserFlight` opens the dependency
  // phase in its first statement, and a starter that was not yet a participant
  // would miss it.
  const joined = joinBrowserFlight(flight, opts);
  void runBrowserFlight(flight);
  return joined;
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

  const browser = await getBrowser({
    onDownloadProgress: opts.onDownloadProgress,
    onDependencyPhase: opts.onDependencyPhase,
    shouldCancel: opts.shouldCancel,
  });
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
