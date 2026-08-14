import { describe, it, expect } from "vitest";
import { slotSketchPath, slotUnitPath, cardSketchesDir } from "@/lib/storyboard/paths";

describe("storyboard slot paths", () => {
  it("sketch PNG lives directly under the card's sketches dir", () => {
    expect(slotSketchPath("c1", "sk_2")).toBe("storyboard/cards/c1/sketches/sk_2.png");
  });
  it("sketches dir is per-card", () => {
    expect(cardSketchesDir("c1")).toBe("storyboard/cards/c1/sketches");
  });
  it("unit path joins the slot's render file relative to the card dir", () => {
    expect(slotUnitPath("c1", { id: "sk_2", role: "end", paramKey: "end_frame", render: { kind: "satori", file: "sketches/sk_2/unit.jsx" } }))
      .toBe("storyboard/cards/c1/sketches/sk_2/unit.jsx");
  });
  it("unit path honors a legacy in-place render file", () => {
    expect(slotUnitPath("c1", { id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "render.jsx" } }))
      .toBe("storyboard/cards/c1/render.jsx");
  });
});
