import { describe, it, expect } from "vitest";
import {
  distributeTrackHeights,
  rowSizing,
  type TrackRowSizing,
} from "@/lib/preview/track-heights";
import type { TrackRowVM } from "@/lib/preview/track-stack-view-model";
import type { LayerRowVM } from "@/lib/overlays/layers-view-model";

function overlayRow(group: string, subLaneCount: number): TrackRowVM {
  const row = { group, subLaneCount, layers: [] } as unknown as LayerRowVM;
  return {
    kind: "overlay",
    overlayKind: "text",
    overlayId: "o",
    z: 0,
    group,
    railLabel: group,
    railIcon: "ti-stack",
    row,
  };
}

const rows: TrackRowSizing[] = [
  { id: "captions", minHeight: 28, weight: 1 },
  { id: "stickers", minHeight: 28, weight: 5 },
  { id: "video", minHeight: 28, weight: 5 },
  { id: "audio", minHeight: 22, weight: 1 },
];

describe("distributeTrackHeights", () => {
  it("returns minHeights when there is no leftover space", () => {
    const h = distributeTrackHeights({ rows, available: 50, gap: 4 });
    expect(h).toEqual({ captions: 28, stickers: 28, video: 28, audio: 22 });
  });
  it("distributes leftover by weight and fills available exactly (minus gaps)", () => {
    // minSum=106, gaps=3*4=12, available=406 → leftover=288, totalWeight=12
    const h = distributeTrackHeights({ rows, available: 406, gap: 4 });
    const sum = Object.values(h).reduce((a, b) => a + b, 0);
    expect(sum + 12).toBe(406); // rows + gaps fill the panel exactly
    expect(h.stickers).toBeGreaterThan(h.captions); // large-weight grows more
    expect(h.video).toBe(h.stickers); // equal weight → equal height
    expect(h.captions).toBeGreaterThan(28); // small-weight still grows a little
  });
  it("zero-weight rows never grow", () => {
    const h = distributeTrackHeights({
      rows: [
        { id: "a", minHeight: 30, weight: 0 },
        { id: "b", minHeight: 30, weight: 1 },
      ],
      available: 200,
      gap: 0,
    });
    expect(h.a).toBe(30);
    expect(h.b).toBe(170);
  });
  it("empty rows → empty map", () => {
    expect(distributeTrackHeights({ rows: [], available: 100, gap: 4 })).toEqual({});
  });
});

describe("rowSizing", () => {
  it("captions (text) is small growth (weight 1)", () => {
    const s = rowSizing(overlayRow("captions", 1));
    expect(s.weight).toBe(1);
    expect(s.id).toBe("ov-captions");
    expect(s.minHeight).toBe(28);
  });
  it("stickers / graphics / tracked are large growth (weight 5)", () => {
    expect(rowSizing(overlayRow("stickers", 1)).weight).toBe(5);
    expect(rowSizing(overlayRow("graphics", 1)).weight).toBe(5);
    expect(rowSizing(overlayRow("tracked", 1)).weight).toBe(5);
  });
  it("custom/unknown overlay group is medium growth (weight 3)", () => {
    expect(rowSizing(overlayRow("mygroup", 1)).weight).toBe(3);
  });
  it("a 2-sublane overlay row reserves its stacked lanes as minHeight", () => {
    expect(rowSizing(overlayRow("captions", 2)).minHeight).toBe(56);
  });
  it("video row is large growth (weight 5), audio row small (weight 1)", () => {
    const video = rowSizing({
      kind: "video",
      railLabel: "Video",
      railIcon: "ti-movie",
      scenes: [],
    } as unknown as TrackRowVM);
    expect(video).toEqual({ id: "video", minHeight: 28, weight: 5 });
    const audio = rowSizing({
      kind: "audio",
      railLabel: "Audio",
      railIcon: "ti-volume",
      clipIds: [],
    } as unknown as TrackRowVM);
    expect(audio).toEqual({ id: "audio", minHeight: 22, weight: 1 });
  });
  it("audio row minHeight scales with clip count (one ~24px lane per clip + gaps)", () => {
    const one = rowSizing({ kind: "audio", railLabel: "Audio", railIcon: "ti-volume", clipIds: ["a"] } as unknown as TrackRowVM);
    expect(one).toEqual({ id: "audio", minHeight: 24, weight: 1 });
    const three = rowSizing({ kind: "audio", railLabel: "Audio", railIcon: "ti-volume", clipIds: ["a", "b", "c"] } as unknown as TrackRowVM);
    // 3*24 + 2*4 = 80
    expect(three).toEqual({ id: "audio", minHeight: 80, weight: 1 });
  });
});
