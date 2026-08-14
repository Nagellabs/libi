import { describe, it, expect } from "vitest";
import {
  defaultGroupForKind,
  groupForOverlay,
  packLanes,
  buildLaneRows,
  deriveZ,
} from "@/lib/overlays/lanes";
import type { Overlay } from "@/lib/engine/types";

function bar(
  id: string,
  kind: Overlay["kind"],
  startTime: number,
  duration: number,
  group?: string,
): Overlay {
  const base = {
    id,
    startTime,
    duration,
    z: 0,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    opacity: 1,
    ...(group ? { group } : {}),
  };
  switch (kind) {
    case "text":
      return { ...base, kind, content: "", font: "", color: "", align: "left" };
    case "image":
      return { ...base, kind, fileId: "f" };
    case "video":
      return { ...base, kind, fileId: "f" };
    case "code":
      return { ...base, kind, drawFunction: "" };
    case "three":
      return { ...base, kind, sceneFunction: "" };
    case "tracked":
      return {
        ...base,
        kind,
        trackId: "t",
        content: { kind: "emoji", char: "x" },
        fit: "tight",
        scale: 1,
        smoothing: "linear",
      };
  }
}

describe("defaultGroupForKind", () => {
  it("maps each kind to its default group", () => {
    expect(defaultGroupForKind("text")).toBe("captions");
    expect(defaultGroupForKind("image")).toBe("stickers");
    expect(defaultGroupForKind("video")).toBe("stickers");
    expect(defaultGroupForKind("code")).toBe("graphics");
    expect(defaultGroupForKind("three")).toBe("graphics");
    expect(defaultGroupForKind("tracked")).toBe("tracked");
  });
});

describe("groupForOverlay", () => {
  it("uses explicit group when present", () => {
    expect(groupForOverlay(bar("a", "text", 0, 1, "myrow"))).toBe("myrow");
  });
  it("falls back to the kind default when group is absent", () => {
    expect(groupForOverlay(bar("a", "image", 0, 1))).toBe("stickers");
  });
});

describe("packLanes", () => {
  it("50 sequential non-overlapping bars pack onto exactly 1 sub-lane", () => {
    const bars = Array.from({ length: 50 }, (_, i) =>
      bar(`b${i}`, "text", i, 1),
    );
    const lane = packLanes(bars);
    const subLanes = new Set(Object.values(lane));
    expect(subLanes.size).toBe(1);
    expect(Object.values(lane).every((s) => s === 0)).toBe(true);
  });

  it("two overlapping bars need 2 sub-lanes", () => {
    const bars = [bar("a", "text", 0, 5), bar("b", "text", 2, 5)];
    const lane = packLanes(bars);
    expect(new Set(Object.values(lane)).size).toBe(2);
    expect(lane["a"]).toBe(0);
    expect(lane["b"]).toBe(1);
  });

  it("a bar starting exactly at the prior bar's end reuses the lane (end <= start)", () => {
    const bars = [bar("a", "text", 0, 2), bar("b", "text", 2, 2)];
    const lane = packLanes(bars);
    expect(lane["a"]).toBe(0);
    expect(lane["b"]).toBe(0);
  });

  it("triple overlap needs 3 sub-lanes", () => {
    const bars = [
      bar("a", "text", 0, 10),
      bar("b", "text", 1, 10),
      bar("c", "text", 2, 10),
    ];
    const lane = packLanes(bars);
    expect(new Set(Object.values(lane)).size).toBe(3);
  });

  it("is stable — ties on startTime break by id, same input → same output", () => {
    const bars = [
      bar("z", "text", 0, 5),
      bar("a", "text", 0, 5),
      bar("m", "text", 0, 5),
    ];
    const first = packLanes(bars);
    const second = packLanes(bars.slice().reverse());
    // id-tiebreak: "a" sorts first → sub-lane 0, "m" → 1, "z" → 2.
    expect(first["a"]).toBe(0);
    expect(first["m"]).toBe(1);
    expect(first["z"]).toBe(2);
    expect(second).toEqual(first);
  });
});

describe("buildLaneRows", () => {
  it("groups overlays into ordered rows with packed sub-lanes", () => {
    const overlays = [
      bar("cap1", "text", 0, 1),
      bar("cap2", "text", 1, 1),
      bar("sticker1", "image", 0, 2),
    ];
    const rows = buildLaneRows(overlays);
    const captions = rows.find((r) => r.group === "captions");
    const stickers = rows.find((r) => r.group === "stickers");
    expect(captions).toBeDefined();
    expect(stickers).toBeDefined();
    // captions pack to 1 sub-lane (sequential)
    expect(captions!.subLaneCount).toBe(1);
    expect(captions!.overlayIds.sort()).toEqual(["cap1", "cap2"]);
    expect(stickers!.overlayIds).toEqual(["sticker1"]);
  });

  it("orders rows deterministically by group label", () => {
    const overlays = [bar("a", "image", 0, 1), bar("b", "text", 0, 1)];
    const rows = buildLaneRows(overlays);
    expect(rows.map((r) => r.group)).toEqual(["captions", "stickers"]);
  });
});

describe("deriveZ", () => {
  it("assigns strictly increasing z; front rows get higher z than back rows", () => {
    const overlays = [bar("cap", "text", 0, 1), bar("stk", "image", 0, 1)];
    const rows = buildLaneRows(overlays);
    const z = deriveZ(rows);
    // rows are ordered back→front by row index; the LAST row is front-most
    // and must get the HIGHEST z.
    const frontGroup = rows[rows.length - 1].group;
    const backGroup = rows[0].group;
    const frontId = rows[rows.length - 1].overlayIds[0];
    const backId = rows[0].overlayIds[0];
    expect(z[frontId]).toBeGreaterThan(z[backId]);
    expect(frontGroup).not.toBe(backGroup);
  });

  it("z is consistent with within-row startTime order", () => {
    const overlays = [bar("late", "text", 5, 1), bar("early", "text", 0, 1)];
    const rows = buildLaneRows(overlays);
    const z = deriveZ(rows);
    // same row, same sub-lane: earlier startTime → lower z
    expect(z["early"]).toBeLessThan(z["late"]);
  });

  it("all z values are unique integers", () => {
    const overlays = [
      bar("a", "text", 0, 1),
      bar("b", "image", 0, 1),
      bar("c", "code", 0, 1),
    ];
    const z = deriveZ(buildLaneRows(overlays));
    const vals = Object.values(z);
    expect(new Set(vals).size).toBe(vals.length);
    expect(vals.every((v) => Number.isInteger(v))).toBe(true);
  });
});
