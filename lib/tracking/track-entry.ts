/**
 * Browser-side entry for the face/object tracker.
 *
 * Loaded via `/api/track-bundle` into the static `/track` HTML shell which
 * runs inside the headless Playwright Chromium driven by `mediapipe-runner`.
 *
 * Flow:
 *   1. Fetch job payload from `/api/tracks/job/[jobId]` (token-gated).
 *   2. Initialize MediaPipe Tasks Vision (face landmarker or object detector).
 *   3. (Face mode + anchors) For each anchor, seek to its time and call
 *      detectFaceOnFrame with the anchor bbox as the crop hint — two-stage
 *      pipeline (anchor crop, BlazeFace fallback) computes the fingerprint.
 *   4. Mount a hidden `<video>` pointing at `fileUrl`.
 *   5. Seek frame-by-frame at `fps`. Face mode: detectFaceOnFrame(prev).
 *      Object mode: detectForVideo(videoEl, t_ms) on the full frame.
 *   6. Identity gate (face mode + anchors): spatial distance-to-prev matching
 *      with fingerprint tiebreak. No face-api.js embedding step.
 *      Object mode: IoU-match to prev; NO largest-face fallback — that bug
 *      caused random people to be picked across scene cuts.
 *   7. POST samples back to `/api/tracks/result`.
 */
import { FilesetResolver, ObjectDetector } from "@mediapipe/tasks-vision";
import type { Anchor, LibiTrackConfig } from "@/lib/tracking/types";
import {
  fingerprintSimilarity,
  iouRect,
  type FaceFingerprint,
} from "@/lib/tracking/face-fingerprint";
import {
  setupDetectors,
  detectFaceOnFrame,
  closeDetectors,
  type Detectors,
} from "@/lib/tracking/face-detection";

interface JobInfo {
  jobId: string;
  payload: {
    fileId: string;
    fileUrl: string;
    fps: number;
    objectKind: "face" | "object";
    subjectQuery?: string;
  };
}

interface TrackSample {
  t: number;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
  visible: boolean;
  subjectId: string | null;
}

function setStatus(msg: string) {
  const el = document.getElementById("status");
  if (el) el.textContent = msg;
  console.log("[track]", msg);
}

async function fetchJob(jobId: string, token: string): Promise<JobInfo> {
  const r = await fetch(
    `/api/tracks/job/${encodeURIComponent(jobId)}?token=${encodeURIComponent(token)}`,
  );
  if (!r.ok) throw new Error(`fetch job failed: ${r.status}`);
  return r.json();
}

async function postResult(
  jobId: string,
  token: string,
  samples: TrackSample[],
  framerate: number,
  method: string,
) {
  const r = await fetch("/api/tracks/result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId, token, samples, framerate, method }),
  });
  if (!r.ok) throw new Error(`post result failed: ${r.status}`);
}

async function postError(jobId: string, token: string, message: string) {
  try {
    await fetch("/api/tracks/error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId, token, message }),
    });
  } catch {
    /* swallow */
  }
}

async function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
    video.currentTime = t;
  });
}

/**
 * AnchorFingerprint bundles a fingerprint with the position of the anchor's
 * bbox (for seeding `prev` on the first frame near this anchor).
 */
interface AnchorFingerprint {
  fingerprint: FaceFingerprint;
  bbox: { x: number; y: number; w: number; h: number };
  time: number;
}

async function runTrack({ jobId, token }: { jobId: string; token: string }) {
  try {
    // Locally-served MediaPipe asset root + anchors, injected by the runner
    // via page.addInitScript before this script executes. modelBaseUrl must
    // be set — bundled assets live under ~/.libi/models/ and are routed
    // through /api/models/[...path]. anchors is required for the face path.
    const cfg = (
      window as unknown as { __libiTrackConfig?: LibiTrackConfig }
    ).__libiTrackConfig;
    if (!cfg?.modelBaseUrl) {
      throw new Error(
        "__libiTrackConfig.modelBaseUrl not set — runner failed to inject",
      );
    }
    const MODEL_BASE_URL = cfg.modelBaseUrl;
    const anchors: Anchor[] = cfg.anchors ?? [];
    const startFrame = cfg.startFrame ?? 0;
    const priorSamples = (cfg.priorSamples ?? []) as TrackSample[];

    setStatus("fetching job");
    const job = await fetchJob(jobId, token);
    const { fileUrl, fps, objectKind } = job.payload;
    const isFace = objectKind === "face";

    if (isFace && anchors.length === 0) {
      throw new Error(
        "face mode requires at least one anchor — none provided by runner. " +
          "Pass anchors[] when calling compute_object_track.",
      );
    }

    setStatus("creating detector");
    let detectors: Detectors | null = null;
    let objectDetector: ObjectDetector | null = null;
    let method: string;
    if (isFace) {
      detectors = await setupDetectors({ modelBaseUrl: MODEL_BASE_URL });
      method = "mediapipe-face";
    } else {
      setStatus("loading MediaPipe");
      // Wasm + model assets are served locally from ~/.libi/models/mediapipe-vision/
      // via /api/models/[...path] — no CDN dependency at runtime.
      const fileset = await FilesetResolver.forVisionTasks(
        `${MODEL_BASE_URL}/mediapipe-vision/wasm`,
      );
      objectDetector = await ObjectDetector.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: `${MODEL_BASE_URL}/mediapipe-vision/models/efficientdet_lite0.tflite`,
        },
        runningMode: "VIDEO",
        scoreThreshold: 0.4,
      });
      method = "mediapipe-object";
    }

    setStatus("loading video");
    const video = document.getElementById("video") as HTMLVideoElement;
    video.src = fileUrl;
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadedmetadata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("video load failed")), {
        once: true,
      });
    });

    const videoW = video.videoWidth;
    const videoH = video.videoHeight;

    // Precompute anchor fingerprints exactly once (face mode + anchors only).
    // For each anchor: seek the video to its time, then run the two-stage
    // detectFaceOnFrame pipeline — Path A crops around the anchor bbox so
    // FaceLandmarker sees a properly framed face even on wide shots; Path B
    // falls back to BlazeFace on the full frame when the anchor-crop turns
    // up nothing. Anchors that produce no detection in either path are
    // warned but not fatal — we only throw if ALL anchors fail.
    const anchorFingerprints: AnchorFingerprint[] = [];
    if (isFace && anchors.length > 0 && detectors) {
      setStatus(`fingerprinting ${anchors.length} anchors`);
      for (const a of anchors) {
        await seekTo(video, a.time);
        const anchorRect = { x: a.bbox[0], y: a.bbox[1], w: a.bbox[2], h: a.bbox[3] };
        const r = detectFaceOnFrame(detectors, video, videoW, videoH, anchorRect);
        if (!r) {
          console.log("[track] anchor t=", a.time, "— two-stage detect failed, skipping");
          continue;
        }
        anchorFingerprints.push({
          fingerprint: r.fingerprint,
          bbox: r.bbox,
          time: a.time,
        });
      }

      if (anchorFingerprints.length === 0) {
        throw new Error(
          "Two-stage face detection found no face at any anchor. " +
            "Verify the anchor bboxes actually overlap the subject's face — " +
            "the BlazeFace fallback was also tried and failed.",
        );
      }
    }

    const duration = video.duration;
    const stepSec = 1 / fps;
    const totalFrames = Math.floor(duration * fps);
    setStatus(`tracking ${totalFrames} frames`);

    // Gating radius for spatial distance-to-prev matching (face mode).
    // A detection's center must be within GATE_RADIUS × prev_w of prev center.
    const GATE_RADIUS = 1.5;
    // Fingerprint similarity threshold — below this we treat the match as
    // a different person (or a false positive) and emit invisible.
    const FINGERPRINT_GATE = 0.35;
    // Minimum IoU with prev for object-mode matching. Below this we treat the
    // detection as "different object" and drop it (better an invisible gap
    // than a wrong subject — that was bug #2).
    const IOU_THRESHOLD = 0.3;

    // Seed from any prior samples (resume path). The runner persisted these
    // via __libiCheckpoint on a previous attempt; we pick up where it left off.
    const samples: TrackSample[] = [...priorSamples];
    let prev: { x: number; y: number; w: number; h: number } | null = null;
    // Find the last visible sample so face/object-mode continuity survives
    // across resume — otherwise we'd drop every detection until a new prev
    // is established.
    for (let k = samples.length - 1; k >= 0; k--) {
      const s = samples[k];
      if (s.visible) {
        prev = { x: s.x, y: s.y, w: s.w, h: s.h };
        break;
      }
    }

    // If there are no prior samples, seed prev from the closest anchor's bbox.
    if (prev === null && anchorFingerprints.length > 0) {
      // Pick the anchor closest in time to frame 0 (or startFrame).
      let closestAnchor = anchorFingerprints[0];
      let closestDist = Math.abs(closestAnchor.time - startFrame * stepSec);
      for (const af of anchorFingerprints) {
        const d = Math.abs(af.time - startFrame * stepSec);
        if (d < closestDist) {
          closestDist = d;
          closestAnchor = af;
        }
      }
      prev = closestAnchor.bbox;
    }

    let lastCheckpointAt = startFrame;
    let cancelled = false;

    const win = window as unknown as {
      __libiReportProgress?: (a: number, b: number, c?: number) => void;
      __libiShouldCancel?: () => Promise<boolean> | boolean;
      __libiCheckpoint?: (s: {
        framesDone: number;
        partialSamples: TrackSample[];
      }) => Promise<void>;
    };

    // Wall-clock cancel poll: belt-and-braces alongside the 30-frame counter
    // below. At fps=15 the frame-based check fires only every ~2s; this timer
    // ensures we never exceed 1s between cancel checks regardless of fps.
    // Cheap — `__libiShouldCancel` is a single Playwright IPC binding.
    let lastCancelPollMs = Date.now();
    const CANCEL_POLL_INTERVAL_MS = 1000;

    for (let i = startFrame; i < totalFrames; i++) {
      const t = i * stepSec;
      await seekTo(video, t);

      let chosen: {
        x: number;
        y: number;
        w: number;
        h: number;
        conf: number;
      } | null = null;

      if (isFace && detectors) {
        const r = detectFaceOnFrame(detectors, video, videoW, videoH, prev ?? null);
        if (r) {
          // Fingerprint identity gate — same logic as before, applied to the
          // single detection face-detection returns. detectFaceOnFrame already
          // picked the best detection vs the hint; here we only need to decide
          // whether to ACCEPT it.
          const closestAnchorFp = closestAnchorFingerprint(anchorFingerprints, t);
          const fpSim = closestAnchorFp
            ? fingerprintSimilarity(r.fingerprint, closestAnchorFp)
            : 1.0;

          if (fpSim >= FINGERPRINT_GATE) {
            // Confidence: blend normalized distance from prev with fingerprint
            // similarity, matching the previous formula. When prev is null
            // (first visible frame) we trust the fingerprint similarity alone.
            let conf = fpSim;
            if (prev) {
              const cx = r.bbox.x + r.bbox.w / 2;
              const cy = r.bbox.y + r.bbox.h / 2;
              const prevCx = prev.x + prev.w / 2;
              const prevCy = prev.y + prev.h / 2;
              const dist = Math.sqrt((cx - prevCx) ** 2 + (cy - prevCy) ** 2);
              const gateRadius = GATE_RADIUS * prev.w;
              // Spatial gate: reject impossible jumps (a face teleporting across
              // the frame is almost always a different person grabbed by Path B's
              // BlazeFace fallback after we lost track).
              if (dist <= gateRadius) {
                const normalizedDist = dist / (prev.w + 1e-6);
                conf = Math.max(
                  0,
                  Math.min(1, 0.6 * (1 - normalizedDist / GATE_RADIUS) + 0.4 * fpSim),
                );
              } else {
                conf = 0;
              }
            }
            if (conf > 0 || !prev) {
              chosen = { x: r.bbox.x, y: r.bbox.y, w: r.bbox.w, h: r.bbox.h, conf };
            }
          }
        }
      } else if (!isFace && objectDetector) {
        const r = objectDetector.detectForVideo(video, Math.round(t * 1000));
        const dets = (r.detections ?? []).map((d) => ({
          x: d.boundingBox?.originX ?? 0,
          y: d.boundingBox?.originY ?? 0,
          w: d.boundingBox?.width ?? 0,
          h: d.boundingBox?.height ?? 0,
        }));

        // Object mode: prefer IoU with prev; no largest-area fallback.
        // CLIP-style embedding for objects is a follow-up task.
        if (dets.length > 0 && prev) {
          let bestScore = -1;
          for (const d of dets) {
            const s = iouRect(prev, d);
            if (s > bestScore && s > IOU_THRESHOLD) {
              bestScore = s;
              chosen = { ...d, conf: s };
            }
          }
        }
      }

      if (chosen) {
        prev = { x: chosen.x, y: chosen.y, w: chosen.w, h: chosen.h };
        samples.push({
          t,
          x: chosen.x,
          y: chosen.y,
          w: chosen.w,
          h: chosen.h,
          confidence: chosen.conf,
          visible: true,
          subjectId: "subject_1",
        });
      } else {
        // Invisible samples carry zeros, NOT stale prev coords (bug #4).
        // sample.ts's AND visibility (bug #5 fix) means downstream consumers
        // never read these as real positions — they're hidden across the gap.
        samples.push({
          t,
          x: 0,
          y: 0,
          w: 0,
          h: 0,
          confidence: 0,
          visible: false,
          subjectId: null,
        });
      }

      if (i % 30 === 0) setStatus(`tracking ${i}/${totalFrames}`);

      // Emit progress + poll cancel every 30 frames (and on the final frame).
      // Cheap from the page's POV — the exposed Playwright bindings are
      // single-port IPC calls, not full network round-trips.
      const nowMs = Date.now();
      const cancelByTime = nowMs - lastCancelPollMs >= CANCEL_POLL_INTERVAL_MS;
      if (i % 30 === 0 || i === totalFrames - 1 || cancelByTime) {
        try {
          win.__libiReportProgress?.(i + 1, totalFrames);
        } catch {
          /* progress is best-effort */
        }
        try {
          lastCancelPollMs = nowMs;
          const c = await win.__libiShouldCancel?.();
          if (c) {
            await win.__libiCheckpoint?.({
              framesDone: i + 1,
              partialSamples: samples,
            });
            cancelled = true;
            break;
          }
        } catch {
          /* cancel poll is best-effort */
        }
      }

      // Persist resume state every ~90 frames (3s @ 30fps). Cheap JSON write
      // server-side; lets a killed run restart with most work preserved.
      if (i - lastCheckpointAt >= 90) {
        try {
          await win.__libiCheckpoint?.({
            framesDone: i + 1,
            partialSamples: samples,
          });
        } catch {
          /* checkpoint is best-effort */
        }
        lastCheckpointAt = i;
      }
    }

    if (cancelled) {
      setStatus(`cancelled at ${samples.length}/${totalFrames}`);
      if (detectors) closeDetectors(detectors);
      if (objectDetector) (objectDetector as { close?: () => void }).close?.();
      // Don't postResult on cancel — the JobManager will mark the job
      // cancelled and the runner Promise rejects with CancelledError.
      // Returning here keeps the page-side flow clean; the runner sees
      // job.done reject via the registry path (postError isn't appropriate
      // either — cancellation isn't an error).
      await postError(jobId, token, "cancelled");
      return;
    }

    setStatus(`done: ${samples.length} samples`);
    if (detectors) closeDetectors(detectors);
    if (objectDetector) (objectDetector as { close?: () => void }).close?.();
    await postResult(jobId, token, samples, fps, method);
    setStatus("posted");
  } catch (err) {
    console.error("[track] error", err);
    setStatus("error: " + (err as Error).message);
    await postError(jobId, token, (err as Error).message);
  }
}

/** Returns the fingerprint from the anchor closest in time to `t`. */
function closestAnchorFingerprint(
  anchorFingerprints: Array<{ fingerprint: FaceFingerprint; time: number }>,
  t: number,
): FaceFingerprint | null {
  if (anchorFingerprints.length === 0) return null;
  let closest = anchorFingerprints[0];
  let closestDist = Math.abs(closest.time - t);
  for (const af of anchorFingerprints) {
    const d = Math.abs(af.time - t);
    if (d < closestDist) {
      closestDist = d;
      closest = af;
    }
  }
  return closest.fingerprint;
}

(window as unknown as { __libiTrack: { runTrack: typeof runTrack } }).__libiTrack = {
  runTrack,
};
