import { describe, it, expect } from "vitest";
import { captionCuesOf, resolveScopeTargets, groupStyleRef } from "@/lib/captions/group";
import type { Overlay } from "@/lib/engine/types";

const cue = (id: string, start: number, useTrackStyle = true): Overlay => ({
  id, kind: "text", startTime: start, duration: 1, z: 10, opacity: 1,
  rect: { x: 0, y: 0, width: 10, height: 10 }, content: id, font: "10px Inter",
  color: "#fff", align: "center", caption: { groupId: "g", styleRef: "pop", useTrackStyle },
}) as Overlay;

describe("caption group", () => {
  const overlays = [cue("b", 2), cue("a", 1), cue("c", 3, false)];
  it("orders cues by start, only the group", () => {
    expect(captionCuesOf(overlays, "g").map((o) => o.id)).toEqual(["a", "b", "c"]);
  });
  it("scope all targets only synced cues (excludes detached c)", () => {
    expect(resolveScopeTargets(overlays, "g", "all").sort()).toEqual(["a", "b"]);
  });
  it("scope cue targets exactly that cue", () => {
    expect(resolveScopeTargets(overlays, "g", "cue", "c")).toEqual(["c"]);
  });
  it("groupStyleRef reads the first synced cue", () => {
    expect(groupStyleRef(overlays, "g")).toBe("pop");
  });
});
