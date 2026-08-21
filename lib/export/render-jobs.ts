/**
 * NOTE: This is the in-process page→server callback bus for the Chromium
 * render page. The render page POSTs results back to
 * `/api/export/render-result/...` which calls `resolveRenderJob` here, and
 * errors land via `/api/export/render-error/...` calling `rejectRenderJob`.
 *
 * The job-tracking lifecycle (queue, dedupe, cancel, status, progress) is
 * owned by the generic JobManager (`lib/jobs/manager.ts`) — the
 * `exportRenderRunner` (in `lib/jobs/runners/export-render.ts`) drives this
 * registry as an IPC implementation detail.
 *
 * Both will probably consolidate in a future refactor; for now they're
 * complementary.
 */
import { randomUUID } from "node:crypto";
import type { ExportSettings, Overlay, AudioClip } from "@/lib/engine/types";
import type { FileRecord } from "@/lib/db/schema/types";

/**
 * Payload the `/render` page needs to reconstruct a runtime `Composition`.
 *
 * We deliberately do NOT store a hydrated `Composition` here. Functions (the
 * compiled `scene.draw` callables) don't survive `JSON.stringify`, so anything
 * the render page fetches from `/api/export/render-job/[jobId]` has to be raw
 * data that the client re-hydrates via `buildComposition(...)`.
 */
export interface RenderPayload {
  overlays: Overlay[];
  audioClips: AudioClip[];
  width: number;
  height: number;
  fps: number;
  files: FileRecord[];
  /**
   * Total composition frame count (`getCompositionFrames`). Set by the chromium
   * route; the runner uses it to plan chunks. Absent on old persisted jobs →
   * the runner falls back to the single-page path.
   */
  totalFrames?: number;
  /**
   * When present, the render page renders only this sub-range (one chunk of a
   * chunked parallel render). The chunk file starts at t=0. Absent → full
   * composition.
   */
  frameRange?: { startFrame: number; endFrameExclusive: number };
}

export interface RenderJobInit {
  pieceId: string;
  payload: RenderPayload;
  settings: ExportSettings;
  /** Overrides the absolute runaway cap (`RENDER_ABSOLUTE_CAP_MS`). Test seam. */
  timeoutMs?: number;
  /** Overrides the sliding stall timeout (`RENDER_STALL_TIMEOUT_MS`). Test seam. */
  stallTimeoutMs?: number;
  /** Optional callback fired when the in-page render bundle reports per-frame
   *  progress via /api/export/render-progress. */
  onProgress?: (done: number, total: number) => void;
}

export interface RenderJobSuccess {
  tempFilePath: string;
  durationSeconds: number;
}

export interface RenderJobHandle {
  jobId: string;
  token: string;
  done: Promise<RenderJobSuccess>;
}

interface JobEntry {
  jobId: string;
  token: string;
  pieceId: string;
  payload: RenderPayload;
  settings: ExportSettings;
  resolve: (value: RenderJobSuccess) => void;
  reject: (err: Error) => void;
  /** Sliding stall timer — reset on every progress tick. */
  stallTimer: NodeJS.Timeout;
  /** Runaway backstop — never reset. */
  absoluteTimer: NodeJS.Timeout;
  /** Effective stall duration, so a progress tick can re-arm identically. */
  stallTimeoutMs: number;
  /** Latest progress seen, used to build the stall-timeout message. */
  lastProgress: { done: number; total: number } | null;
  settled: boolean;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Sliding stall timeout: a render is only killed if NO per-frame progress POST
 * arrives within this window. Armed at `createRenderJob` (covers page boot +
 * hydrate) and reset on every `recordRenderProgress` tick — a healthy render at
 * any fps stays alive indefinitely.
 */
export const RENDER_STALL_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Runaway backstop: never reset. Even a render that keeps reporting progress is
 * killed once total wall time exceeds this cap.
 */
export const RENDER_ABSOLUTE_CAP_MS = 60 * 60 * 1000;

/**
 * The registry must survive Next.js dev HMR — the runner (JobManager
 * background work) writes here, and the route handler at
 * `/api/export/render-job/[jobId]` reads from here. In dev, route
 * handlers can be reloaded into a different module instance than the
 * one the runner is holding a reference to, so a plain module-level
 * `Map` shows up empty on the read side and the render page gets a
 * 404. Stash the singleton on globalThis (same trick lib/db/client.ts
 * uses for the DB handle) so all imports of this module resolve to the
 * same Map. Verified by e2e/electron/libi-home-and-export.spec.ts.
 */
const globalForRenderJobs = globalThis as unknown as {
  __libi_render_jobs?: Map<string, JobEntry>;
};
const jobs: Map<string, JobEntry> =
  globalForRenderJobs.__libi_render_jobs ?? new Map<string, JobEntry>();
if (!globalForRenderJobs.__libi_render_jobs) {
  globalForRenderJobs.__libi_render_jobs = jobs;
}

export function createRenderJob(init: RenderJobInit): RenderJobHandle {
  const jobId = randomUUID();
  const token = randomUUID();
  let resolve!: (v: RenderJobSuccess) => void;
  let reject!: (e: Error) => void;
  const done = new Promise<RenderJobSuccess>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const stallTimeoutMs = init.stallTimeoutMs ?? RENDER_STALL_TIMEOUT_MS;
  const absoluteCapMs = init.timeoutMs ?? RENDER_ABSOLUTE_CAP_MS;

  // Sliding stall timer — reset on every progress tick (see recordRenderProgress).
  const stallTimer = setTimeout(() => {
    const entry = jobs.get(jobId);
    if (entry && !entry.settled) {
      entry.settled = true;
      clearTimeout(entry.absoluteTimer);
      jobs.delete(jobId);
      const seconds = stallTimeoutMs / 1000;
      const message = entry.lastProgress
        ? `Render job ${jobId} stalled — no progress for ${seconds}s (frame ${entry.lastProgress.done}/${entry.lastProgress.total})`
        : `Render job ${jobId} stalled — no progress reported within ${seconds}s`;
      reject(new Error(message));
    }
  }, stallTimeoutMs);

  // Runaway backstop — never reset.
  const absoluteTimer = setTimeout(() => {
    const entry = jobs.get(jobId);
    if (entry && !entry.settled) {
      entry.settled = true;
      clearTimeout(entry.stallTimer);
      jobs.delete(jobId);
      reject(
        new Error(
          `Render job ${jobId} exceeded the ${absoluteCapMs / 60000}-minute absolute cap`,
        ),
      );
    }
  }, absoluteCapMs);

  jobs.set(jobId, {
    jobId,
    token,
    pieceId: init.pieceId,
    payload: init.payload,
    settings: init.settings,
    resolve,
    reject,
    stallTimer,
    absoluteTimer,
    stallTimeoutMs,
    lastProgress: null,
    settled: false,
    onProgress: init.onProgress,
  });
  return { jobId, token, done };
}

export function getRenderJob(jobId: string, token: string): JobEntry | null {
  const entry = jobs.get(jobId);
  if (!entry || entry.settled || entry.token !== token) return null;
  return entry;
}

// Note: a timeout firing between getRenderJobTokenByJobId() and resolveRenderJob()
// is harmless — this function re-checks entry.settled inside the critical section.
// The worst case is that a driver-timed postback gets a false return value and the
// client has already received the timeout rejection.
export function resolveRenderJob(jobId: string, token: string, value: RenderJobSuccess): boolean {
  const entry = jobs.get(jobId);
  if (!entry || entry.settled || entry.token !== token) return false;
  entry.settled = true;
  clearTimeout(entry.stallTimer);
  clearTimeout(entry.absoluteTimer);
  jobs.delete(jobId);
  entry.resolve(value);
  return true;
}

export function rejectRenderJob(jobId: string, token: string, message: string): boolean {
  const entry = jobs.get(jobId);
  if (!entry || entry.settled || entry.token !== token) return false;
  entry.settled = true;
  clearTimeout(entry.stallTimer);
  clearTimeout(entry.absoluteTimer);
  jobs.delete(jobId);
  entry.reject(new Error(message));
  return true;
}

/** Called by the in-page render bundle to report per-frame progress.
 *  Token-validated like the result endpoint. Stashes the latest progress and
 *  resets the sliding stall timer so a healthy render never times out. */
export function recordRenderProgress(
  jobId: string,
  token: string,
  done: number,
  total: number,
): void {
  const entry = jobs.get(jobId);
  if (!entry) return;
  if (entry.token !== token) return;
  if (entry.settled) return;
  entry.lastProgress = { done, total };
  clearTimeout(entry.stallTimer);
  entry.stallTimer = setTimeout(() => {
    const current = jobs.get(jobId);
    if (current && !current.settled) {
      current.settled = true;
      clearTimeout(current.absoluteTimer);
      jobs.delete(jobId);
      const seconds = current.stallTimeoutMs / 1000;
      const message = current.lastProgress
        ? `Render job ${jobId} stalled — no progress for ${seconds}s (frame ${current.lastProgress.done}/${current.lastProgress.total})`
        : `Render job ${jobId} stalled — no progress reported within ${seconds}s`;
      current.reject(new Error(message));
    }
  }, entry.stallTimeoutMs);
  entry.onProgress?.(done, total);
}

/** True while the job exists and has not settled. Driver-side polling seam. */
export function isRenderJobPending(jobId: string): boolean {
  const entry = jobs.get(jobId);
  return !!entry && !entry.settled;
}

export function __resetRegistryForTests() {
  for (const entry of jobs.values()) {
    clearTimeout(entry.stallTimer);
    clearTimeout(entry.absoluteTimer);
  }
  jobs.clear();
}

/**
 * Returns the token for an unsettled job, without requiring the caller to know it.
 *
 * Driver-side only — drivers run in the trusted server context and need the token
 * to construct the `/render?jobId=X&token=Y` URL. Also used by tests to settle
 * jobs whose tokens the test didn't generate.
 *
 * Do NOT call this from untrusted surfaces (API handlers, render page). Those
 * must use `getRenderJob(jobId, token)` with an explicit token.
 */
export function getRenderJobTokenByJobId(jobId: string): { token: string } | null {
  const entry = jobs.get(jobId);
  if (!entry || entry.settled) return null;
  return { token: entry.token };
}
