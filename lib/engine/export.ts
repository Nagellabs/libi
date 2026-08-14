/** MediaBunny video export for the Libi composition engine */

import {
  Output,
  Mp4OutputFormat,
  WebMOutputFormat,
  BufferTarget,
  CanvasSource,
} from 'mediabunny';
import type { VideoCodec } from 'mediabunny';
import type { Composition, ExportResult, ExportSettings, DrawContext } from './types';
import { collectVideoSeekTargets, getCompositionFrames, renderFrame } from './renderer';
import { chunkFrameMeta, type FrameRange } from './export-frame-range';
import type { VideoFrameSource } from './video-frame-source';
import type { Track } from '@/lib/tracking/types';
import type { ThreeOverlayInstance } from "./three-overlay";
import type { OverlayQuadInstance } from "./overlay-quad";
import type { ContentBox } from "@/lib/overlays/code-content-fit";

/**
 * Keyframe interval (seconds) for the canvas-source encoder. MediaBunny
 * defaults to 5 s, which makes player scrubbing land on far-back keyframes —
 * a paused/scrubbed frame can sit ~1 s behind the playhead. We match libi's
 * proxy cadence (1 keyframe/sec) so exported files seek precisely. Modest
 * size cost; scrub-friendliness wins for a deliverable people scrub.
 */
const EXPORT_KEYFRAME_INTERVAL_S = 1;

/**
 * Exports a composition as a video file using MediaBunny.
 *
 * Renders every frame to an OffscreenCanvas via the unified `renderFrame()`
 * path (the same one the editor preview uses) and feeds it to a CanvasSource,
 * which encodes and muxes the video into the requested format.
 *
 * Delegating to `renderFrame` ensures every scene type AND every overlay kind
 * (text/image/video/code/tracked) renders identically to the preview. Earlier
 * versions of this function inlined a partial scene loop that silently dropped
 * overlays — never re-introduce that.
 *
 * @param composition - The composition to export
 * @param settings - Export format, codec, bitrate, and resolution settings
 * @param onProgress - Optional callback receiving a progress value from 0 to 1
 * @param videoFrameSources - Optional map of VideoFrameSource keyed by scene.id AND video-overlay.id
 * @param imageElements - Optional map of HTMLImageElement keyed by overlay.id (image + tracked-image overlays)
 * @param compiledDrawFns - Optional map of compiled draw fns keyed by overlay.id (code + tracked-code overlays)
 * @param tracks - Optional map of Track keyed by overlay.trackId (tracked overlays)
 * @param threeScenes - Optional map of ThreeOverlayInstance keyed by overlay.id (three overlays)
 * @param spatialQuads - Optional map of OverlayQuadInstance keyed by overlay.id (perspective-tilted image/video/code/flat-text overlays)
 * @param codeContentBoxes - Optional map of probed content ink-bboxes keyed by overlay.id (code overlays) — drives the content contain-fit
 * @param frameRange - Optional sub-range to render (one chunk of a chunked parallel render). When present, the loop renders `[startFrame, endFrameExclusive)`, the encoder timestamp is chunk-local (each chunk file starts at t=0), `onProgress` is chunk-local, and the returned `duration` is the chunk length. Absent → exactly the full-composition behavior (`0 .. getCompositionFrames()`).
 * @returns A promise that resolves with the exported video blob and metadata
 */
export async function exportVideo(
  composition: Composition,
  settings: ExportSettings,
  onProgress?: (progress: number) => void,
  videoFrameSources?: Record<string, VideoFrameSource>,
  imageElements?: Record<string, HTMLImageElement>,
  compiledDrawFns?: Record<string, (ctx: DrawContext) => void>,
  tracks?: Record<string, Track>,
  threeScenes?: Record<string, ThreeOverlayInstance>,
  spatialQuads?: Record<string, OverlayQuadInstance>,
  codeContentBoxes?: Record<string, ContentBox | null>,
  frameRange?: FrameRange,
): Promise<ExportResult> {
  const compositionFrames = getCompositionFrames(composition);
  const fps = settings.fps;
  const frameDuration = 1 / fps;

  // Resolve the render window: a chunk range, or the whole composition.
  const range: FrameRange = frameRange ?? {
    startFrame: 0,
    endFrameExclusive: compositionFrames,
  };
  const chunkFrames = range.endFrameExclusive - range.startFrame;

  // Create an OffscreenCanvas at the export resolution
  const canvas = new OffscreenCanvas(settings.width, settings.height);
  // Sanity-check that we can get a 2D context. renderFrame() will also pull
  // its own ref from the canvas — this preflight just produces a clearer
  // error message before we kick off the encoder.
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
  if (!ctx) {
    throw new Error('Failed to get 2D rendering context from OffscreenCanvas');
  }

  // Set up the output format
  const format =
    settings.format === 'webm'
      ? new WebMOutputFormat()
      : new Mp4OutputFormat();

  const target = new BufferTarget();
  const output = new Output({ format, target });

  // Create the video source with encoding config. The explicit
  // keyFrameInterval overrides MediaBunny's sparse 5 s default so the exported
  // file scrubs/seeks accurately in players (see EXPORT_KEYFRAME_INTERVAL_S).
  const videoSource = new CanvasSource(canvas, {
    codec: settings.codec as VideoCodec,
    bitrate: settings.bitrate,
    keyFrameInterval: EXPORT_KEYFRAME_INTERVAL_S,
  });

  output.addVideoTrack(videoSource, { frameRate: fps });

  await output.start();

  // Render and encode each frame via the unified `renderFrame()` pipeline.
  // It handles scene rendering (canvas vs. video), overlay compositing, and
  // canvas clear + resize internally — do not duplicate any of that here.
  for (let frame = range.startFrame; frame < range.endFrameExclusive; frame++) {
    // CRITICAL: `renderFrame` reads each video source via a SYNCHRONOUS
    // `getFrame()`, which returns the source's last-decoded frame. For a
    // one-shot export we must position every active video source AND wait
    // for the decode to land first, otherwise consecutive frames capture the
    // same stale decoded frame (the export freezes for stretches). The live
    // preview doesn't need this — its rAF loop + hold-last-frame tolerate
    // one-frame decode latency.
    if (videoFrameSources) {
      const seeks = collectVideoSeekTargets(composition, frame);
      if (seeks.length) {
        await Promise.all(
          seeks.map(({ id, time }) => {
            const source = videoFrameSources[id];
            return source?.seekAndDecode
              ? source.seekAndDecode(time)
              : Promise.resolve();
          }),
        );
      }
    }

    renderFrame(
      canvas as unknown as HTMLCanvasElement,
      composition,
      frame,
      {},
      videoFrameSources,
      imageElements,
      compiledDrawFns,
      tracks,
      threeScenes,
      spatialQuads,
      codeContentBoxes,
    );

    // Feed the rendered frame to the encoder. For a chunk, the timestamp is
    // chunk-local (each chunk file starts at t=0) and progress is chunk-local
    // so the concat downstream produces one continuous timeline.
    const { timestamp, progress } = chunkFrameMeta(frame, range, fps);
    await videoSource.add(timestamp, frameDuration);

    // Report progress
    if (onProgress) {
      onProgress(progress);
    }
  }

  // Signal that no more frames will be added
  videoSource.close();

  // Finalize the output
  await output.finalize();

  // Build the result
  const buffer = target.buffer;
  if (!buffer) {
    throw new Error('Export failed: no buffer produced');
  }

  const mimeType =
    settings.format === 'webm' ? 'video/webm' : 'video/mp4';
  const blob = new Blob([buffer], { type: mimeType });
  const duration = chunkFrames / fps;

  return {
    blob,
    duration,
    format: settings.format,
  };
}
