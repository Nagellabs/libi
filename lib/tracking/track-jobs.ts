/**
 * NOTE: This is the page→server IPC bridge for `track-entry.ts` (running
 * inside Playwright Chromium) to post results back to `runFaceTracker` /
 * `runObjectTracker` via HTTP. It is NOT the same as the JobManager
 * (`lib/jobs/manager.ts`) which owns the job lifecycle.
 *
 * The split:
 *   - JobManager — runs the runner, owns persistence, checkpoints, cancel.
 *   - track-jobs (this file) — bridges the in-browser track-entry's `fetch`
 *     calls back to the awaiting Promise inside the server-side runner.
 *
 * Both will probably consolidate in a future refactor; for now they're
 * complementary.
 */
import { randomUUID } from "node:crypto";
import type { TrackMethod, TrackSample } from "@/lib/tracking/types";

export interface TrackPayload {
  fileId: string;
  /** URL the browser will use to load the source video (e.g. /api/files/by-id/{id}/content). */
  fileUrl: string;
  fps: number;
  objectKind: "face" | "object";
  subjectQuery?: string;
}

export interface TrackJobSuccess {
  samples: TrackSample[];
  framerate: number;
  method: TrackMethod;
}

export interface TrackJobInit {
  pieceId: string;
  payload: TrackPayload;
  timeoutMs?: number;
}

export interface TrackJobHandle {
  jobId: string;
  token: string;
  done: Promise<TrackJobSuccess>;
}

interface JobEntry {
  jobId: string;
  token: string;
  pieceId: string;
  payload: TrackPayload;
  resolve: (value: TrackJobSuccess) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
  settled: boolean;
}

export const TRACK_REGISTRY_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — tracking can be slow on long videos

/**
 * Module-level state must survive Next.js dev-mode module fragmentation —
 * route handlers and the server-side runner can otherwise resolve to
 * different instances of this file and see different Maps. globalThis
 * caching keeps them sharing one registry.
 */
declare global {
  var __libiTrackJobs: Map<string, JobEntry> | undefined;
}
const jobs: Map<string, JobEntry> = globalThis.__libiTrackJobs ?? new Map<string, JobEntry>();
globalThis.__libiTrackJobs = jobs;

export function createTrackJob(init: TrackJobInit): TrackJobHandle {
  const jobId = randomUUID();
  const token = randomUUID();
  let resolve!: (v: TrackJobSuccess) => void;
  let reject!: (e: Error) => void;
  const done = new Promise<TrackJobSuccess>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const timeout = setTimeout(() => {
    const entry = jobs.get(jobId);
    if (entry && !entry.settled) {
      entry.settled = true;
      jobs.delete(jobId);
      reject(new Error(`Track job ${jobId} timeout`));
    }
  }, init.timeoutMs ?? TRACK_REGISTRY_TIMEOUT_MS);
  jobs.set(jobId, {
    jobId,
    token,
    pieceId: init.pieceId,
    payload: init.payload,
    resolve,
    reject,
    timeout,
    settled: false,
  });
  return { jobId, token, done };
}

export function getTrackJob(jobId: string, token: string): JobEntry | null {
  const entry = jobs.get(jobId);
  if (!entry || entry.settled || entry.token !== token) return null;
  return entry;
}

export function resolveTrackJob(
  jobId: string,
  token: string,
  value: TrackJobSuccess,
): boolean {
  const entry = jobs.get(jobId);
  if (!entry || entry.settled || entry.token !== token) return false;
  entry.settled = true;
  clearTimeout(entry.timeout);
  jobs.delete(jobId);
  entry.resolve(value);
  return true;
}

export function rejectTrackJob(jobId: string, token: string, message: string): boolean {
  const entry = jobs.get(jobId);
  if (!entry || entry.settled || entry.token !== token) return false;
  entry.settled = true;
  clearTimeout(entry.timeout);
  jobs.delete(jobId);
  entry.reject(new Error(message));
  return true;
}

export function getTrackJobTokenByJobId(jobId: string): { token: string } | null {
  const entry = jobs.get(jobId);
  if (!entry || entry.settled) return null;
  return { token: entry.token };
}

export function __resetTrackRegistryForTests() {
  for (const entry of jobs.values()) clearTimeout(entry.timeout);
  jobs.clear();
}
