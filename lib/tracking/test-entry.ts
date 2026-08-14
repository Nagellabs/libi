/**
 * Browser-side test harness for `face-detection.ts`. NOT used in
 * production — only consumed by the e2e integration test, which esbuild-
 * bundles this file as IIFE and serves it to headless Playwright Chromium.
 *
 * Exposes `window.__libiFaceDetectionTest.run({...})` which:
 *   1. Calls `setupDetectors` with the provided wasm/model base URL.
 *   2. Loads the test video into a hidden `<video>` element.
 *   3. Seeks to each requested timestamp.
 *   4. Calls `detectFaceOnFrame` with the matching hint bbox (or null).
 *   5. Returns an array of `{ t, hint, result }` per timestamp.
 */
import {
  setupDetectors,
  detectFaceOnFrame,
  closeDetectors,
  type FaceResult,
} from "@/lib/tracking/face-detection";
import type { Bbox } from "@/lib/tracking/face-detection-helpers";

interface RunOpts {
  modelBaseUrl: string;
  videoUrl: string;
  /** Per-timestamp probe. `hint` null → exercise the BlazeFace fallback path. */
  probes: Array<{ t: number; hint: Bbox | null }>;
}

interface ProbeOut {
  t: number;
  hint: Bbox | null;
  /** null when detection failed; otherwise serializable summary. */
  result:
    | null
    | {
        bbox: Bbox;
        source: FaceResult["source"];
        /** Length checks for the fingerprint — full vectors are too large. */
        fingerprintGeometryLen: number;
        fingerprintBlendshapeLen: number;
      };
}

async function run({ modelBaseUrl, videoUrl, probes }: RunOpts): Promise<ProbeOut[]> {
  const d = await setupDetectors({ modelBaseUrl });
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";
    video.src = videoUrl;
    document.body.appendChild(video);
    await new Promise<void>((res, rej) => {
      video.addEventListener("loadedmetadata", () => res(), { once: true });
      video.addEventListener("error", () => rej(new Error("video load failed")), { once: true });
    });
    const W = video.videoWidth;
    const H = video.videoHeight;

    // Headless Chromium silently drops seeks on a paused <video> that has
    // never played — `seeked` fires but currentTime stays at 0, leaving
    // MediaPipe sampling frame 0 regardless of where we wanted to look.
    // The reliable workaround is to play the video through at high speed
    // and capture each requested timestamp via requestVideoFrameCallback
    // as the playback cursor crosses it.
    type RVFCVideo = HTMLVideoElement & {
      requestVideoFrameCallback?: (
        cb: (now: number, meta: { mediaTime: number }) => void,
      ) => number;
    };
    const rVFC = (video as RVFCVideo).requestVideoFrameCallback?.bind(video);

    const targets = probes.map((p) => p.t).sort((a, b) => a - b);
    const captures = new Map<number, ImageBitmap>();

    if (!rVFC) {
      throw new Error("test-entry: requestVideoFrameCallback unavailable");
    }

    video.playbackRate = 4; // burn through the clip fast
    await video.play();

    await new Promise<void>((res, rej) => {
      let nextIdx = 0;
      const onFrame = async (
        _now: number,
        meta: { mediaTime: number },
      ): Promise<void> => {
        while (nextIdx < targets.length && meta.mediaTime >= targets[nextIdx]) {
          const t = targets[nextIdx];
          try {
            const bmp = await createImageBitmap(video);
            captures.set(t, bmp);
          } catch (err) {
            rej(err as Error);
            return;
          }
          nextIdx++;
        }
        if (nextIdx >= targets.length) {
          res();
          return;
        }
        rVFC(onFrame);
      };
      rVFC(onFrame);
      video.addEventListener(
        "ended",
        () => {
          if (nextIdx < targets.length) {
            rej(new Error(`video ended before capturing all targets: got ${nextIdx}/${targets.length}`));
          }
        },
        { once: true },
      );
    });
    video.pause();

    const out: ProbeOut[] = [];
    for (const p of probes) {
      const bmp = captures.get(p.t);
      if (!bmp) {
        out.push({ t: p.t, hint: p.hint, result: null });
        continue;
      }
      const fr = detectFaceOnFrame(d, bmp, W, H, p.hint);
      out.push({
        t: p.t,
        hint: p.hint,
        result: fr
          ? {
              bbox: fr.bbox,
              source: fr.source,
              fingerprintGeometryLen: fr.fingerprint.geometry.length,
              fingerprintBlendshapeLen: fr.fingerprint.blendshapes.length,
            }
          : null,
      });
    }
    for (const bmp of captures.values()) bmp.close();
    return out;
  } finally {
    closeDetectors(d);
  }
}

(window as unknown as {
  __libiFaceDetectionTest: { run: typeof run };
}).__libiFaceDetectionTest = { run };
