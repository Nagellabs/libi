import { describe, it, expect } from "vitest";
import {
  buildConcatListContent,
  concatRenderChunks,
} from "@/lib/export/concat-renders";

describe("buildConcatListContent", () => {
  it("wraps each absolute path in a quoted concat-demuxer entry", () => {
    const content = buildConcatListContent([
      "/tmp/libi-render-a/out.mp4",
      "/tmp/libi-render-b/out.mp4",
    ]);
    expect(content).toBe(
      "file '/tmp/libi-render-a/out.mp4'\n" +
        "file '/tmp/libi-render-b/out.mp4'\n",
    );
  });

  it("escapes single quotes in a path as '\\'' so it round-trips", () => {
    const content = buildConcatListContent(["/tmp/it's a/out.mp4"]);
    // ffmpeg concat demuxer: a literal quote inside single-quotes is '\''
    expect(content).toBe("file '/tmp/it'\\''s a/out.mp4'\n");
  });

  it("handles paths with spaces without additional escaping", () => {
    const content = buildConcatListContent(["/tmp/my renders/out 1.mp4"]);
    expect(content).toBe("file '/tmp/my renders/out 1.mp4'\n");
  });
});

describe("concatRenderChunks", () => {
  it("single path in → returned unchanged (no ffmpeg run)", async () => {
    const p = "/tmp/libi-render-solo/out.mp4";
    await expect(concatRenderChunks([p], "mp4")).resolves.toBe(p);
  });

  it("throws on an empty path list", async () => {
    await expect(concatRenderChunks([], "mp4")).rejects.toThrow(
      /no chunk paths/i,
    );
  });
});
