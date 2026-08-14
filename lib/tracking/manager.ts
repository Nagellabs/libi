import { EventEmitter } from "node:events";
import { serverLogger as logger } from "@/lib/logger";
import type { TrackSample, TrackMethod, Anchor } from "@/lib/tracking/types";
import { nextTrackState, type TrackState } from "@/lib/tracking/state";

// Input shape mirrors the Playwright runner (FaceTrackerOpts + objectKind).
export interface RunnerInput {
  fileUrl: string;
  fileId: string;
  pieceId: string;
  fps: number;
  subjectQuery?: string;
  objectKind: "face" | "object";
  /** Reference frames identifying the subject. Wired through Task 8; gate lands in Task 10. */
  anchors?: Anchor[];
}
export interface RunnerOutput { samples: TrackSample[]; framerate: number }
export type Runner = (input: RunnerInput) => Promise<RunnerOutput>;

export interface EnqueueArgs {
  jobKey: string;
  trackId: string;
  pieceId: string;
  fileId: string;
  fileUrl: string;
  fps: number;
  method: TrackMethod;          // mediapipe-face | mediapipe-object | manual
  objectKind: "face" | "object";
  subjectQuery?: string;
  anchors?: Anchor[];
  onComplete?: (out: RunnerOutput) => Promise<void>;
}

export class TrackingManager extends EventEmitter {
  private inflight = new Map<string, Promise<RunnerOutput>>();
  private states = new Map<string, TrackState>();

  constructor(private opts: { runner: Runner }) { super(); }

  private setState(trackId: string, ev: { type: "enqueue" | "start" | "success" | "error" }) {
    const cur = this.states.get(trackId) ?? "idle";
    const next = nextTrackState(cur, ev);
    this.states.set(trackId, next);
    this.emit("state", { trackId, state: next });
  }

  getState(trackId: string): TrackState { return this.states.get(trackId) ?? "idle"; }

  async enqueue(args: EnqueueArgs): Promise<RunnerOutput> {
    const existing = this.inflight.get(args.jobKey);
    if (existing) return existing;
    this.setState(args.trackId, { type: "enqueue" });
    const p = (async () => {
      this.setState(args.trackId, { type: "start" });
      try {
        const runnerPromise = this.opts.runner({
          fileUrl: args.fileUrl,
          fileId: args.fileId,
          pieceId: args.pieceId,
          fps: args.fps,
          subjectQuery: args.subjectQuery,
          objectKind: args.objectKind,
          anchors: args.anchors,
        });
        // Attach noop handler synchronously to prevent "unhandledRejection"
        // before the await below picks up the rejection.
        runnerPromise.catch(() => {});
        const out = await runnerPromise;
        if (args.onComplete) await args.onComplete(out);
        this.setState(args.trackId, { type: "success" });
        return out;
      } catch (err) {
        logger.error({ err, trackId: args.trackId }, "tracking.runner.error");
        this.setState(args.trackId, { type: "error" });
        throw err;
      } finally {
        this.inflight.delete(args.jobKey);
      }
    })();
    // Attach a noop rejection handler to suppress "unhandledRejection" for the
    // inflight reference — callers receive `p` and handle rejection themselves.
    p.catch(() => {});
    this.inflight.set(args.jobKey, p);
    return p;
  }
}
