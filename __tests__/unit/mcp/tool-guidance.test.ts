/**
 * Findings of the live test cycle that were wording, not behaviour: what a tool says when the agent
 * gets it wrong (add_keyframe's empty `properties`, snapshot's `confirm`) and a property text that
 * stated the wrong range (caption fontWeight).
 */
import { describe, it, expect } from "vitest";
import { actionRunnerFor } from "@/mcp/tools/action-tool";
import { snapshotTool } from "@/mcp/tools/families/snapshot";
import { keyframePropertiesRefusal, KEYABLE_KEYFRAME_FIELDS } from "@/mcp/tools/advertised-schemas";
import {
  addOverlaySchema,
  createCaptionStyleSchema,
  discardDraftSchema,
  restoreSnapshotSchema,
} from "@/mcp/tools/schemas";

describe("fontWeight texts state the real range", () => {
  it("caption_style accepts 800 and says so", () => {
    expect(createCaptionStyleSchema.safeParse({ name: "Bold", color: "#ffd400", fontWeight: 800 }).success).toBe(true);
    const text = createCaptionStyleSchema.shape.fontWeight.description ?? "";
    expect(text).toContain("800");
    expect(text).toMatch(/100-900/);
    expect(text).not.toBe("400 | 500 | 600 | 700 | 900.");
  });

  it("a text overlay's fontWeight is described, with 800", () => {
    const text = (addOverlaySchema as unknown as { shape: Record<string, { description?: string }> }).shape.fontWeight?.description ?? "";
    expect(text).toContain("800");
    expect(text).toContain("100 to 900");
  });
});

describe("add_keyframe with nothing keyable", () => {
  it("names the keyable fields and the unknown keys it received", () => {
    const msg = keyframePropertiesRefusal({ pieceId: "p", overlayId: "o", time: 0, properties: { x: -900 } })!;
    expect(msg).toBeTruthy();
    for (const field of KEYABLE_KEYFRAME_FIELDS) expect(msg).toContain(field);
    expect(msg).toContain("Unknown, so ignored: x");
    expect(msg).toMatch(/inside `position` or `rect`/);
  });

  it("keyable fields come from the schema", () => {
    expect([...KEYABLE_KEYFRAME_FIELDS].sort()).toEqual(["opacity", "position", "rect", "rotation", "scale", "transform3d", "volumeDb"]);
  });

  it("says an empty `properties` was empty, and reports several unknown keys", () => {
    expect(keyframePropertiesRefusal({ properties: {} })).toContain("`properties` was empty");
    expect(keyframePropertiesRefusal({ properties: { left: 1, top: 2 } })).toContain("Unknown, so ignored: left, top");
  });

  it("stays out of the way when something is keyable, or properties is absent", () => {
    expect(keyframePropertiesRefusal({ properties: { opacity: 0.5, x: 3 } })).toBeNull();
    expect(keyframePropertiesRefusal({ properties: { position: { x: 1, y: 2 } } })).toBeNull();
    expect(keyframePropertiesRefusal({})).toBeNull();
    expect(keyframePropertiesRefusal(undefined)).toBeNull();
    expect(keyframePropertiesRefusal({ properties: "x" })).toBeNull();
  });
});

describe("snapshot discard / restore: confirm is the user's yes", () => {
  const confirmText = (schema: { shape: { confirm: { description?: string } } }) => schema.shape.confirm.description ?? "";

  it("the property text says only after the user said yes, never on your own", () => {
    for (const schema of [discardDraftSchema, restoreSnapshotSchema]) {
      expect(confirmText(schema)).toMatch(/ONLY after the user said yes/);
      expect(confirmText(schema)).toMatch(/Never set it on your own/);
    }
  });

  it("a call without confirm is refused with 'ask the user first', and runs nothing", async () => {
    const { run } = actionRunnerFor(snapshotTool);
    for (const [action, args] of [
      ["discard", { pieceId: "p" }],
      ["restore", { pieceId: "p", snapshotId: "s0" }],
    ] as const) {
      const out = await run(action, { ...args }, undefined);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error).toMatch(/ask the user before/);
        expect(out.error).toMatch(/said yes in this conversation/);
        expect(out.error).toContain(`${action} requires: pieceId`);
      }
    }
  });

  it("a confirm of false is refused the same way", async () => {
    const { run } = actionRunnerFor(snapshotTool);
    const out = await run("discard", { pieceId: "p", confirm: false }, undefined);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/ask the user before discarding the draft/);
  });
});
