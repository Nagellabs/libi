import { describe, it, expect } from "vitest";
import {
  hiddenIdSetFromSignature,
  hiddenIdSignature,
  hiddenOverlayIdSet,
  isHiddenLinkedAudio,
  stripHiddenAudioClips,
  stripHiddenLayerArrays,
  stripHiddenLayers,
  stripNonDecodingOverlays,
} from "@/lib/overlays/hidden";
import { updateOverlaySchema } from "@/mcp/tools/schemas";
import type { AudioClip, Composition } from "@/lib/engine/types";

const rect = { x: 0, y: 0, width: 1920, height: 1080 };
function comp(over: Partial<Composition> = {}): Composition {
  return {
    id: "c1", width: 1920, height: 1080, fps: 30, scenes: [],
    overlays: [
      { id: "vid-a", kind: "video", fileId: "fa", startTime: 0, duration: 7, z: 0, opacity: 1, rect },
      { id: "vid-hidden", kind: "video", fileId: "fb", startTime: 0, duration: 7, z: 1, opacity: 1, rect, hidden: true },
    ],
    audioClips: [
      { id: "a-hidden", kind: "inline", fileId: "fb", startTime: 0, duration: 7, trimStart: 0, volume: 1, enabled: true, linkedOverlayId: "vid-hidden" },
      { id: "a-keep", kind: "inline", fileId: "fa", startTime: 0, duration: 7, trimStart: 0, volume: 1, enabled: true, linkedOverlayId: "vid-a" },
      { id: "a-detached", kind: "standalone", fileId: "fb", startTime: 0, duration: 7, trimStart: 0, volume: 1, enabled: true, linkedOverlayId: "vid-hidden" },
    ],
    ...over,
  } as unknown as Composition;
}

describe("hidden helpers (field-sourced)", () => {
  it("hiddenOverlayIdSet reads the field", () => {
    const c = comp();
    expect(hiddenOverlayIdSet(c.overlays)).toEqual(new Set(["vid-hidden"]));
    expect(hiddenOverlayIdSet([{ id: "x" }])).toBeUndefined();
    expect(hiddenOverlayIdSet(undefined)).toBeUndefined();
  });

  it("stripHiddenLayers drops the hidden overlay AND its coupled clip; keeps detached", () => {
    const out = stripHiddenLayers(comp());
    expect(out.overlays?.map((o) => o.id)).toEqual(["vid-a"]);
    expect(out.audioClips?.map((c) => c.id)).toEqual(["a-keep", "a-detached"]);
  });

  it("identity passthrough when nothing is hidden", () => {
    const c = comp({
      overlays: [{ id: "vid-a", kind: "video", fileId: "fa", startTime: 0, duration: 7, z: 0, opacity: 1, rect }] as Composition["overlays"],
    });
    expect(stripHiddenLayers(c)).toBe(c);
    expect(stripNonDecodingOverlays(c)).toBe(c);
    expect(stripNonDecodingOverlays(null)).toBeNull();
  });

  it("stripHiddenAudioClips schedules exactly the non-hidden-coupled set", () => {
    const c = comp();
    const hiddenIds = hiddenOverlayIdSet(c.overlays);
    const out = stripHiddenAudioClips(c.audioClips as AudioClip[], hiddenIds);
    expect(out.map((x) => x.id)).toEqual(["a-keep", "a-detached"]);
    // Identity when no overlay is hidden.
    const clips = c.audioClips as AudioClip[];
    expect(stripHiddenAudioClips(clips, undefined)).toBe(clips);
    expect(stripHiddenAudioClips(clips, new Set())).toBe(clips);
  });

  it("hiddenIdSignature is a stable memo key: unchanged by overlay edits, changed by hide toggles", () => {
    // The preview keys the audio-schedule memo on this signature so an overlay
    // DRAG (rect change → new overlays array identity) never re-reconciles the
    // audio engine — only an actual hide-set change does.
    const before = comp().overlays!;
    const afterDrag = before.map((o) =>
      o.id === "vid-a" ? { ...o, rect: { x: 50, y: 50, width: 1920, height: 1080 } } : o,
    );
    expect(afterDrag).not.toBe(before); // the identity churn the signature absorbs
    expect(hiddenIdSignature(afterDrag)).toBe(hiddenIdSignature(before));

    const afterUnhide = before.map((o) => (o.id === "vid-hidden" ? { ...o, hidden: false } : o));
    expect(hiddenIdSignature(afterUnhide)).not.toBe(hiddenIdSignature(before));
    expect(hiddenIdSignature(afterUnhide)).toBe("");

    // Round-trip: the signature reconstructs the exact set (sorted, multi-id).
    const multi = before.map((o) => ({ ...o, hidden: true }));
    expect(hiddenIdSetFromSignature(hiddenIdSignature(multi))).toEqual(
      new Set(["vid-a", "vid-hidden"]),
    );
    expect(hiddenIdSetFromSignature("")).toBeUndefined();
  });

  it("stripHiddenLayerArrays works on manifest-shaped arrays and reports changed", () => {
    const c = comp();
    const r = stripHiddenLayerArrays(c.overlays, c.audioClips);
    expect(r.changed).toBe(true);
    expect(r.overlays?.map((o) => o.id)).toEqual(["vid-a"]);
    const same = stripHiddenLayerArrays([{ id: "x" }], undefined);
    expect(same.changed).toBe(false);
    expect(same.overlays).toEqual([{ id: "x" }]);
  });

  it("isHiddenLinkedAudio: inline+linked matches, detached never does", () => {
    const set = new Set(["v1"]);
    expect(isHiddenLinkedAudio({ kind: "inline", linkedOverlayId: "v1" }, set)).toBe(true);
    expect(isHiddenLinkedAudio({ kind: "standalone", linkedOverlayId: "v1" }, set)).toBe(false);
    expect(isHiddenLinkedAudio({ kind: "inline", linkedOverlayId: "v2" }, set)).toBe(false);
    expect(isHiddenLinkedAudio({ kind: "inline" }, undefined)).toBe(false);
  });
});

describe("update_overlay schema — hidden", () => {
  it("accepts hidden: boolean and rejects non-boolean", () => {
    expect(
      updateOverlaySchema.safeParse({ pieceId: "p", overlayId: "o", hidden: true }).success,
    ).toBe(true);
    expect(
      updateOverlaySchema.safeParse({ pieceId: "p", overlayId: "o", hidden: "yes" }).success,
    ).toBe(false);
  });
});
