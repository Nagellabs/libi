// __tests__/unit/tracking/family-a-classes-forwarding.test.ts
import { describe, it, expect } from "vitest";
import { ComputeObjectTrackSchema } from "@/mcp/tools/schemas";

describe("Family A — classes reachable via compute_object_track", () => {
  it("ComputeObjectTrackSchema accepts an optional free-form classes[]", () => {
    const ok = ComputeObjectTrackSchema.safeParse({
      fileId: "f", objectKind: "object",
      anchors: [{ fileId: "f", time: 0, bbox: [1, 2, 3, 4] }],
      classes: ["backpack"],
    });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.classes).toEqual(["backpack"]);
  });
  it("classes is optional (omitting it still parses — back-compat)", () => {
    const ok = ComputeObjectTrackSchema.safeParse({
      fileId: "f", objectKind: "object",
      anchors: [{ fileId: "f", time: 0, bbox: [1, 2, 3, 4] }],
    });
    expect(ok.success).toBe(true);
  });
  it("rejects an empty-string class element", () => {
    const bad = ComputeObjectTrackSchema.safeParse({
      fileId: "f", objectKind: "object",
      anchors: [{ fileId: "f", time: 0, bbox: [1, 2, 3, 4] }],
      classes: [""],
    });
    expect(bad.success).toBe(false);
  });
});
