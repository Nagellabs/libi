import { TrackingManager, type RunnerInput, type RunnerOutput } from "./manager";
import { runFaceTracker, runObjectTracker } from "./mediapipe-runner";

const globalForTracking = globalThis as unknown as { __libiTrackingManager?: TrackingManager };

export function getTrackingManager(): TrackingManager {
  if (!globalForTracking.__libiTrackingManager) {
    globalForTracking.__libiTrackingManager = new TrackingManager({
      runner: async (input: RunnerInput): Promise<RunnerOutput> => {
        // TODO(Task 10): runner-side identity gate consumes these anchors via
        // __libiTrackConfig. Forwarded now so the plumbing is complete;
        // currently the in-browser runner ignores them.
        const opts = {
          fileUrl: input.fileUrl,
          fileId: input.fileId,
          pieceId: input.pieceId,
          fps: input.fps,
          subjectQuery: input.subjectQuery,
          anchors: input.anchors,
        };
        return input.objectKind === "face" ? runFaceTracker(opts) : runObjectTracker(opts);
      },
    });
  }
  return globalForTracking.__libiTrackingManager;
}
