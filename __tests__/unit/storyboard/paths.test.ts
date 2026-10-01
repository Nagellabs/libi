import { describe, it, expect, vi, afterEach } from "vitest";
import { slotSketchPath, slotUnitPath, cardSketchesDir } from "@/lib/storyboard/paths";
import { serverLogger } from "@/lib/logger";

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
  it("a path-traversal render file is refused on read, falling back to the default unit path", () => {
    expect(slotUnitPath("c1", { id: "s1", render: { file: "../../../x.jsx" } } as never))
      .toBe("storyboard/cards/c1/sketches/s1/unit.jsx");
  });
  it("a render file with a Windows-hazard segment (NTFS alternate data stream) is refused too", () => {
    expect(slotUnitPath("c1", { id: "s1", render: { file: "unit.jsx:ads" } } as never))
      .toBe("storyboard/cards/c1/sketches/s1/unit.jsx");
  });

  describe("a refused render.file is warned; a safe one, or none, is silent", () => {
    afterEach(() => vi.restoreAllMocks());

    it("warns once, tagged storyboard/render_file_refused, when render.file is present and refused", () => {
      const warn = vi.spyOn(serverLogger, "warn").mockImplementation(() => undefined as never);
      const result = slotUnitPath("w1", { id: "s1", render: { file: "../../../x.jsx" } } as never);
      expect(result).toBe("storyboard/cards/w1/sketches/s1/unit.jsx");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatchObject({ tag: "storyboard", op: "render_file_refused", cardId: "w1", slotId: "s1" });
    });

    it("truncates the refused file in the log line rather than logging it unbounded", () => {
      const warn = vi.spyOn(serverLogger, "warn").mockImplementation(() => undefined as never);
      const long = `../${"a".repeat(500)}.jsx`;
      slotUnitPath("w2", { id: "s1", render: { file: long } } as never);
      const logged = (warn.mock.calls[0][0] as { file: string }).file;
      expect(logged.length).toBeLessThanOrEqual(120);
    });

    it("warns once per card, slot and file — the watcher re-renders every card on any storyboard edit", () => {
      const warn = vi.spyOn(serverLogger, "warn").mockImplementation(() => undefined as never);
      const refused = { id: "s1", render: { file: "../y.jsx" } } as never;
      slotUnitPath("w3", refused);
      slotUnitPath("w3", refused);
      expect(warn).toHaveBeenCalledTimes(1);
      slotUnitPath("w3", { id: "s1", render: { file: "../z.jsx" } } as never);
      slotUnitPath("w4", refused);
      expect(warn).toHaveBeenCalledTimes(3);
    });

    it("does not warn for a safe render.file", () => {
      const warn = vi.spyOn(serverLogger, "warn").mockImplementation(() => undefined as never);
      slotUnitPath("c1", { id: "sk_2", role: "end", paramKey: "end_frame", render: { kind: "satori", file: "sketches/sk_2/unit.jsx" } });
      expect(warn).not.toHaveBeenCalled();
    });

    it("does not warn when the slot has no render.file at all", () => {
      const warn = vi.spyOn(serverLogger, "warn").mockImplementation(() => undefined as never);
      slotUnitPath("c1", { id: "s1" } as never);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

describe("isSafeCardRelativePath (re-exported for repo.ts's write-side check)", () => {
  it("is exported from paths.ts, not private to repo.ts", async () => {
    const { isSafeCardRelativePath } = await import("@/lib/storyboard/paths");
    expect(isSafeCardRelativePath("sketches/sk_1/unit.jsx")).toBe(true);
    expect(isSafeCardRelativePath("../x.jsx")).toBe(false);
    expect(isSafeCardRelativePath("unit.jsx:ads")).toBe(false);
  });
});
