/**
 * Frame → `HH:MM:SS:FF` SMPTE timecode (hours : minutes : seconds :
 * frame-within-second). This is the industry-standard readout used by Premiere
 * Pro, DaVinci Resolve, Avid, and Final Cut — the four-group shape is what makes
 * it unambiguous (`00:00:00:09` can only mean 9 frames, never 9 seconds).
 *
 * This is the single source of truth for the playhead timecode the timeline
 * ruler shows AND for the timestamp the ask-agent composer embeds, so the two
 * can never disagree (the user's selector reads exactly what the prompt says).
 */
export function frameToTimecode(frame: number, fps: number): string {
  const f = Math.max(0, frame);
  const safeFps = fps > 0 ? fps : 30;
  const totalSeconds = f / safeFps;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const frames = Math.floor(f % safeFps);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
}
