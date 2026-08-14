import { describe, it, expect } from "vitest";
import { navigationEmitter } from "@/lib/navigation-events";
import { POST } from "@/app/api/notify/route";

describe("/api/notify right_region", () => {
  it("emits right_region with mode + mcpId", async () => {
    const seen: unknown[] = [];
    const handler = (e: unknown) => seen.push(e);
    navigationEmitter.on("right_region", handler);

    const res = await POST(
      new Request("http://x/api/notify", {
        method: "POST",
        body: JSON.stringify({ type: "right_region", mode: "api-config", mcpId: "fal-ai" }),
      }),
    );
    navigationEmitter.off("right_region", handler);

    expect(res.status).toBe(200);
    expect(seen).toEqual([{ mode: "api-config", mcpId: "fal-ai" }]);
  });

  it("omits mcpId when absent and emits the given mode", async () => {
    const seen: unknown[] = [];
    const handler = (e: unknown) => seen.push(e);
    navigationEmitter.on("right_region", handler);

    await POST(
      new Request("http://x/api/notify", {
        method: "POST",
        body: JSON.stringify({ type: "right_region", mode: "onboarding" }),
      }),
    );
    navigationEmitter.off("right_region", handler);

    expect(seen).toEqual([{ mode: "onboarding", mcpId: undefined }]);
  });

  it("falls back to editor on a malformed mode", async () => {
    const seen: Array<{ mode: string }> = [];
    const handler = (e: { mode: string }) => seen.push(e);
    navigationEmitter.on("right_region", handler);

    await POST(
      new Request("http://x/api/notify", {
        method: "POST",
        body: JSON.stringify({ type: "right_region", mode: 42 }),
      }),
    );
    navigationEmitter.off("right_region", handler);

    expect(seen[0]?.mode).toBe("editor");
  });
});
