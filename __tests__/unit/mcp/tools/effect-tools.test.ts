import { describe, it, expect } from "vitest";
import { listEffectsTool, applyLayerEffect, highlightEffect } from "@/mcp/tools/effect-tools";

describe("list_effects tool", () => {
  it("returns built-in effects with meta", async () => {
    const r = await listEffectsTool({});
    expect(r.success).toBe(true);
    const ids = (r.data!.effects as { id: string }[]).map((e) => e.id);
    expect(ids).toContain("fade");
    expect(ids).toContain("bounce");
    expect(ids).toContain("typewriter");
  });
  it("filters by kind=audio", async () => {
    const r = await listEffectsTool({ kind: "audio" });
    const effects = r.data!.effects as { id: string; supports: string[] }[];
    expect(effects.every((e) => e.supports.includes("audio"))).toBe(true);
    expect(effects.map((e) => e.id)).toContain("audio-fade-in");
  });
  it("filters by phase=loop excludes fade", async () => {
    const r = await listEffectsTool({ phase: "loop" });
    const ids = (r.data!.effects as { id: string }[]).map((e) => e.id);
    expect(ids).toContain("pulse");
    expect(ids).not.toContain("fade");
  });
});

describe("apply_layer_effect validation", () => {
  it("rejects unknown effectId with valid id list", async () => {
    const r = await applyLayerEffect({ pieceId: "x", layerId: "y", phase: "in", effectId: "nope" });
    expect(r.success).toBe(false);
    expect(r.error).toBe("unknown_effect");
    expect((r.data as { validIds: string[] }).validIds).toContain("fade");
  });
  it("rejects an unsupported phase (fade has no loop)", async () => {
    const r = await applyLayerEffect({ pieceId: "x", layerId: "y", phase: "loop", effectId: "fade" });
    expect(r.success).toBe(false);
    expect(r.error).toBe("phase_unsupported");
  });
});

describe("highlight_effect tool", () => {
  it("rejects an unknown catalog effectId", async () => {
    const r = await highlightEffect({ pieceId: "p", target: { kind: "catalog", effectId: "nope" } });
    expect(r.success).toBe(false);
    expect(r.error).toBe("unknown_effect");
  });
  it("accepts a valid catalog effect (notify is fire-and-forget)", async () => {
    const r = await highlightEffect({ pieceId: "p", target: { kind: "catalog", effectId: "fade", phase: "in" } });
    expect(r.success).toBe(true);
  });
  it("accepts an applied target without effect validation", async () => {
    const r = await highlightEffect({ pieceId: "p", target: { kind: "applied", layerId: "ov1", phase: "in" } });
    expect(r.success).toBe(true);
  });
});
