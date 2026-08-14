import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB + port + schema before importing the tool.
const rows: Record<string, unknown>[] = [];
vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({ all: () => rows.slice() }),
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/db/schema", () => ({ files: {} }));
vi.mock("@/lib/libi-home", () => ({ getCurrentPort: () => 3468 }));

import { showInChat } from "@/mcp/tools/chat-media-tools";

beforeEach(() => {
  rows.length = 0;
});

describe("showInChat", () => {
  it("returns a chatMedia payload + absolute URL for an existing image file", async () => {
    rows.push({ id: "img1", contentType: "image/png", filename: "shot.png", pieceId: "p1" });
    const res = await showInChat({ fileId: "img1", caption: "Scene 1 sketch" });
    expect(res).toEqual({
      success: true,
      data: {
        chatMedia: {
          fileId: "img1",
          kind: "image",
          contentType: "image/png",
          filename: "shot.png",
          caption: "Scene 1 sketch",
        },
        url: "http://localhost:3468/api/files/by-id/img1/content",
      },
    });
  });

  it("classifies video/audio kinds and omits an absent caption", async () => {
    rows.push({ id: "v1", contentType: "video/mp4", filename: "take.mp4", pieceId: "p1" });
    const res = await showInChat({ fileId: "v1" });
    expect(res.success).toBe(true);
    const media = (res.data as { chatMedia: { kind: string; caption?: string } }).chatMedia;
    expect(media.kind).toBe("video");
    expect(media.caption).toBeUndefined();
  });

  it("returns file_not_found for an unknown id", async () => {
    const res = await showInChat({ fileId: "missing" });
    expect(res).toEqual({ success: false, error: "file_not_found" });
  });
});
