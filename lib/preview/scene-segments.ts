/**
 * Pure geometry for the timeline's Video track scene blocks. Maps each scene's
 * duration to a [leftPct, widthPct] in the SAME frame space the playhead uses
 * (currentFrame / totalFrames), so blocks line up with the playhead exactly.
 * NO React, NO DOM — unit-tested in isolation.
 */
export interface SceneSegmentRect {
  id: string;
  name: string;
  leftPct: number;
  widthPct: number;
}

export function sceneSegments(
  scenes: { id: string; name: string; duration: number }[],
  fps: number,
  totalFrames: number,
): SceneSegmentRect[] {
  if (totalFrames <= 0) {
    return scenes.map((s) => ({ id: s.id, name: s.name, leftPct: 0, widthPct: 0 }));
  }
  let acc = 0;
  return scenes.map((s) => {
    const frames = Math.round(s.duration * fps);
    const leftPct = (acc / totalFrames) * 100;
    const widthPct = (frames / totalFrames) * 100;
    acc += frames;
    return { id: s.id, name: s.name, leftPct, widthPct };
  });
}
