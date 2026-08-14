/**
 * Task 3.3 — Saving a caption as a reusable style preset.
 *
 * The saved fields MUST include the full look + animation
 * (color, stroke, shadow, background, reveal, highlightColor, fontFamily,
 * fontWeight) and MUST EXCLUDE per-instance fields (content, rect, startTime,
 * duration, z, id, kind) AND the caption-track membership object (caption).
 */

import { describe, it, expect } from "vitest";
import { extractPresetFields } from "@/lib/overlays/presets";

/** A karaoke-styled caption overlay fixture that exercises every relevant field. */
const karaokeCaption = {
  // per-instance / structural fields — must be excluded
  id: "overlay-abc123",
  kind: "text",
  content: "Chase the horizon",
  rect: { x: 100, y: 400, width: 1720, height: 120 },
  startTime: 4.2,
  duration: 3.8,
  z: 10,
  // caption-track membership — must NEVER be captured in a style preset
  caption: {
    groupId: "g1",
    styleRef: "karaoke",
    useTrackStyle: true,
  },
  // look / animation fields — must be captured
  color: "#ffffff",
  stroke: { color: "#000000", width: 4 },
  shadow: { color: "rgba(0,0,0,0.8)", blur: 8, dx: 1, dy: 1 },
  background: { color: "rgba(0,0,0,0.5)", padding: 12, radius: 6 },
  reveal: { mode: "karaoke", fraction: 1.0 },
  highlightColor: "#ffcf33",
  fontFamily: "Inter",
  fontWeight: 700,
  font: "700 52px Inter",
  align: "center",
  opacity: 1,
} satisfies Record<string, unknown>;

describe("extractPresetFields — caption style preset", () => {
  it("captures reveal mode (karaoke)", () => {
    const fields = extractPresetFields(karaokeCaption);
    expect(fields.reveal).toEqual({ mode: "karaoke", fraction: 1.0 });
  });

  it("captures highlightColor", () => {
    const fields = extractPresetFields(karaokeCaption);
    expect(fields.highlightColor).toBe("#ffcf33");
  });

  it("captures stroke", () => {
    const fields = extractPresetFields(karaokeCaption);
    expect(fields.stroke).toEqual({ color: "#000000", width: 4 });
  });

  it("captures color, shadow, background, fontFamily, fontWeight", () => {
    const fields = extractPresetFields(karaokeCaption);
    expect(fields.color).toBe("#ffffff");
    expect(fields.shadow).toEqual({ color: "rgba(0,0,0,0.8)", blur: 8, dx: 1, dy: 1 });
    expect(fields.background).toEqual({ color: "rgba(0,0,0,0.5)", padding: 12, radius: 6 });
    expect(fields.fontFamily).toBe("Inter");
    expect(fields.fontWeight).toBe(700);
  });

  it("excludes content (per-cue text)", () => {
    const fields = extractPresetFields(karaokeCaption);
    expect("content" in fields).toBe(false);
  });

  it("excludes rect (positional)", () => {
    const fields = extractPresetFields(karaokeCaption);
    expect("rect" in fields).toBe(false);
  });

  it("excludes startTime and duration (timing)", () => {
    const fields = extractPresetFields(karaokeCaption);
    expect("startTime" in fields).toBe(false);
    expect("duration" in fields).toBe(false);
  });

  it("excludes z (stacking order)", () => {
    const fields = extractPresetFields(karaokeCaption);
    expect("z" in fields).toBe(false);
  });

  it("excludes caption (group membership — must NEVER be captured in a style)", () => {
    const fields = extractPresetFields(karaokeCaption);
    expect("caption" in fields).toBe(false);
  });

  it("excludes id and kind", () => {
    const fields = extractPresetFields(karaokeCaption);
    expect("id" in fields).toBe(false);
    expect("kind" in fields).toBe(false);
  });
});
