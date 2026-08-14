import { describe, it, expect } from "vitest";
import { buildVerifyContent } from "@/mcp/tracking-mcp/register-tracking-tools";

describe("buildVerifyContent", () => {
  it("emits one image block per frame with png + a text block without base64", () => {
    const out = buildVerifyContent({
      success: true,
      data: {
        frames: [
          { time: 0, pngBase64: "AAAA", visible: true, segmentId: "s", method: "m", status: "ok", objectKind: "object", isAnchorFrame: false, sampledRect: null, trackBbox: null },
          { time: 1, error: "boom", visible: false, segmentId: null, method: null, status: null, objectKind: null, isAnchorFrame: false, sampledRect: null, trackBbox: null },
        ],
        summary: { total: 2 },
        segments: [],
        truncated: false,
        coveredIssueRanges: [],
        persistedFileIds: {},
      },
    });
    const imgs = out.content.filter((c) => c.type === "image");
    const txts = out.content.filter((c) => c.type === "text");
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toMatchObject({ type: "image", data: "AAAA", mimeType: "image/png" });
    expect(txts).toHaveLength(1);
    expect(txts[0].text).not.toContain("AAAA");
    expect(JSON.parse(txts[0].text).data.frames[0].time).toBe(0);
  });

  it("falls back to a plain error text block on failure", () => {
    const out = buildVerifyContent({ success: false, error: "nope" });
    expect(out.content).toHaveLength(1);
    expect(out.content[0].type).toBe("text");
    expect(JSON.parse(out.content[0].text).error).toBe("nope");
  });
});
