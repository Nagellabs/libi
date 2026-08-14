import { describe, it, expect } from "vitest";
import { navigationEmitter } from "@/lib/navigation-events";
import { POST } from "@/app/api/notify/route";

describe("/api/notify highlight", () => {
  it("emits highlight with pieceId, overlayId, property, note", async () => {
    const seen: unknown[] = [];
    const handler = (e: unknown) => seen.push(e);
    navigationEmitter.on("highlight", handler);

    const res = await POST(
      new Request("http://x/api/notify", {
        method: "POST",
        body: JSON.stringify({
          type: "highlight",
          pieceId: "p1",
          overlayId: "ov1",
          property: "background.color",
          note: "tweak this",
        }),
      }),
    );
    navigationEmitter.off("highlight", handler);

    expect(res.status).toBe(200);
    expect(seen).toEqual([
      { pieceId: "p1", overlayId: "ov1", property: "background.color", note: "tweak this" },
    ]);
  });

  it("omits note when absent", async () => {
    const seen: Array<{ note?: string }> = [];
    const handler = (e: { note?: string }) => seen.push(e);
    navigationEmitter.on("highlight", handler);

    await POST(
      new Request("http://x/api/notify", {
        method: "POST",
        body: JSON.stringify({
          type: "highlight",
          pieceId: "p1",
          overlayId: "ov1",
          property: "content",
        }),
      }),
    );
    navigationEmitter.off("highlight", handler);

    expect(seen[0]).toEqual({ pieceId: "p1", overlayId: "ov1", property: "content", note: undefined });
  });
});

describe("/api/notify set_complexity_mode", () => {
  it("emits set_complexity_mode with pieceId, overlayId, and the mode", async () => {
    const seen: unknown[] = [];
    const handler = (e: unknown) => seen.push(e);
    navigationEmitter.on("set_complexity_mode", handler);

    const res = await POST(
      new Request("http://x/api/notify", {
        method: "POST",
        body: JSON.stringify({
          type: "set_complexity_mode",
          pieceId: "p1",
          overlayId: "ov1",
          mode: "style",
        }),
      }),
    );
    navigationEmitter.off("set_complexity_mode", handler);

    expect(res.status).toBe(200);
    expect(seen).toEqual([{ pieceId: "p1", overlayId: "ov1", mode: "style" }]);
  });

  it("falls back to transform on a malformed mode", async () => {
    const seen: Array<{ mode: string }> = [];
    const handler = (e: { mode: string }) => seen.push(e);
    navigationEmitter.on("set_complexity_mode", handler);

    await POST(
      new Request("http://x/api/notify", {
        method: "POST",
        body: JSON.stringify({
          type: "set_complexity_mode",
          pieceId: "p1",
          overlayId: "ov1",
          mode: 99,
        }),
      }),
    );
    navigationEmitter.off("set_complexity_mode", handler);

    expect(seen[0]?.mode).toBe("transform");
  });
});
