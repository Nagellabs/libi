import { describe, it, expect } from "vitest";
import { rewriteFileIds } from "@/lib/duplication/rewrite-file-ids";

describe("rewriteFileIds", () => {
  const map = new Map([["old1", "new1"], ["old2", "new2"]]);

  it("rewrites a fileId inside a nested structure", () => {
    const m = {
      scenes: [{ id: "s1", type: "video", fileId: "old1" }],
      audioClips: [{ id: "a1", fileId: "old2" }],
      overlays: [
        { id: "o1", kind: "image", fileId: "old1" },
        { id: "o2", kind: "tracked", trackId: "t1", content: { kind: "video", fileId: "old2" } },
      ],
    };
    const out = rewriteFileIds(m, map) as typeof m;
    expect(out.scenes[0].fileId).toBe("new1");
    expect(out.audioClips[0].fileId).toBe("new2");
    expect(out.overlays[0].fileId).toBe("new1");
    expect((out.overlays[1].content as { fileId: string }).fileId).toBe("new2");
  });
  it("leaves a fileId not in the map untouched", () => {
    const out = rewriteFileIds({ fileId: "unknown" }, map) as { fileId: string };
    expect(out.fileId).toBe("unknown");
  });
  it("does not touch trackId", () => {
    const out = rewriteFileIds({ trackId: "old1" }, map) as { trackId: string };
    expect(out.trackId).toBe("old1");
  });
  it("does not mutate the input", () => {
    const input = { fileId: "old1" };
    rewriteFileIds(input, map);
    expect(input.fileId).toBe("old1");
  });
});
