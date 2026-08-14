import { describe, it, expect } from "vitest";
import { addOverlaySchema, updateOverlaySchema } from "@/mcp/tools/schemas";

const baseRect = { x: 0, y: 0, width: 100, height: 50 };
const common = { pieceId: "p1", startTime: 0, duration: 2, rect: baseRect, z: 0, opacity: 1 };
const textBase = {
  ...common,
  kind: "text" as const,
  content: "hi",
  font: "20px sans",
  color: "#fff",
  align: "center" as const,
};

/** A full caption-styling payload exercising every new optional field. */
const fullStyling = {
  fontFamily: "Inter",
  fontSize: 64,
  fontWeight: 700,
  lineHeight: 1.2,
  background: { color: "#000000", padding: 12, radius: 8 },
  stroke: { color: "#000000", width: 6 },
  shadow: { color: "#000000", blur: 10, dx: 2, dy: 2 },
  reveal: { mode: "typewriter" as const, fraction: 0.5 },
};

describe("overlay schemas — caption styling + reveal (Milestone 3)", () => {
  it("accepts a full styling payload on add_overlay (text)", () => {
    const parsed = addOverlaySchema.safeParse({ ...textBase, ...fullStyling });
    expect(parsed.success).toBe(true);
  });

  it("accepts a full styling payload on update_overlay", () => {
    const parsed = updateOverlaySchema.safeParse({
      pieceId: "p1",
      overlayId: "o1",
      ...fullStyling,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts fontWeight keywords", () => {
    expect(
      addOverlaySchema.safeParse({ ...textBase, fontWeight: "bold" }).success,
    ).toBe(true);
    expect(
      updateOverlaySchema.safeParse({ pieceId: "p1", overlayId: "o1", fontWeight: "lighter" }).success,
    ).toBe(true);
  });

  it("rejects out-of-range stroke.width", () => {
    expect(
      addOverlaySchema.safeParse({ ...textBase, stroke: { color: "#000", width: 999 } }).success,
    ).toBe(false);
    expect(
      updateOverlaySchema.safeParse({
        pieceId: "p1",
        overlayId: "o1",
        stroke: { color: "#000", width: 999 },
      }).success,
    ).toBe(false);
  });

  it("rejects out-of-range shadow.blur", () => {
    expect(
      addOverlaySchema.safeParse({ ...textBase, shadow: { color: "#000", blur: 9999 } }).success,
    ).toBe(false);
    expect(
      updateOverlaySchema.safeParse({
        pieceId: "p1",
        overlayId: "o1",
        shadow: { color: "#000", blur: 9999 },
      }).success,
    ).toBe(false);
  });

  it("rejects out-of-range fontSize", () => {
    expect(addOverlaySchema.safeParse({ ...textBase, fontSize: 2 }).success).toBe(false);
    expect(addOverlaySchema.safeParse({ ...textBase, fontSize: 9999 }).success).toBe(false);
    expect(
      updateOverlaySchema.safeParse({ pieceId: "p1", overlayId: "o1", fontSize: 9999 }).success,
    ).toBe(false);
  });

  it("enforces the reveal.mode enum", () => {
    expect(
      addOverlaySchema.safeParse({ ...textBase, reveal: { mode: "pop" } }).success,
    ).toBe(true);
    expect(
      addOverlaySchema.safeParse({ ...textBase, reveal: { mode: "not-a-mode" } }).success,
    ).toBe(false);
    expect(
      updateOverlaySchema.safeParse({
        pieceId: "p1",
        overlayId: "o1",
        reveal: { mode: "not-a-mode" },
      }).success,
    ).toBe(false);
  });
});
