import { describe, it, expect } from "vitest";
import { parseStoryboard, parseCard } from "@/lib/storyboard/zod";

describe("storyboard zod", () => {
  it("parses a minimal valid card", () => {
    const card = parseCard({
      id: "c1",
      order: 0,
      durationSec: 6,
      role: "hook",
      kind: "canvas",
      title: "Hook",
      sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "render.jsx" } }],
      camera: { shot: "medium" },
      promptFragment: "young editor to camera",
      stage: "schematic",
      approvals: {},
    });
    expect(card.id).toBe("c1");
    expect(card.sketches[0].render?.kind).toBe("satori");
  });

  it("rejects a card with an unknown sketch render kind", () => {
    expect(() =>
      parseCard({
        id: "c1", order: 0, durationSec: 6, role: "hook", kind: "canvas",
        title: "Hook",
        sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "webgl", file: "x" } }],
        camera: { shot: "medium" }, promptFragment: "x",
        stage: "schematic", approvals: {},
      }),
    ).toThrow();
  });

  it("parses a manifest with card order + edges", () => {
    const sb = parseStoryboard({
      version: 2,
      cardOrder: ["c1", "c2"],
      edges: [{ from: "c1", to: "c2" }],
      updatedAt: "2026-06-15T00:00:00.000Z",
    });
    expect(sb.cardOrder).toEqual(["c1", "c2"]);
  });
});

describe("sketch slots", () => {
  it("parses a card with start + end + reference slots", () => {
    const card = parseCard({
      id: "c1", order: 0, durationSec: 5, role: "scene", kind: "ai-video", title: "t",
      camera: { shot: "medium" }, promptFragment: "p", stage: "schematic", approvals: {},
      sketches: [
        { id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "sketches/sk_1/unit.jsx" } },
        { id: "sk_2", role: "end", paramKey: "end_frame", render: { kind: "satori", file: "sketches/sk_2/unit.jsx" } },
        { id: "sk_3", role: "reference", paramKey: "reference_image", label: "hand", render: { kind: "satori", file: "sketches/sk_3/unit.jsx" } },
      ],
    });
    expect(card.sketches).toHaveLength(3);
    expect(card.sketches[2].label).toBe("hand");
  });

  it("rejects a card missing sketches", () => {
    expect(() => parseCard({
      id: "c1", order: 0, durationSec: 5, role: "scene", kind: "ai-video", title: "t",
      camera: { shot: "medium" }, promptFragment: "p", stage: "schematic", approvals: {},
    })).toThrow();
  });
});
