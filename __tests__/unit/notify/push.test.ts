import { describe, it, expect, beforeEach } from "vitest";
import { pushIfBackgrounded, __setTestNotifier } from "@/mcp/notify";

describe("pushIfBackgrounded", () => {
  beforeEach(() => __setTestNotifier(null));

  it("no-ops when no notifier is bound", async () => {
    await expect(pushIfBackgrounded({ title: "x", body: "y" })).resolves.toBeUndefined();
  });

  it("no-ops when window is focused", async () => {
    const calls: unknown[] = [];
    __setTestNotifier({
      isFocused: () => true,
      notify: (p) => calls.push(p),
    });
    await pushIfBackgrounded({ title: "x", body: "y" });
    expect(calls).toEqual([]);
  });

  it("fires when window is not focused", async () => {
    const calls: unknown[] = [];
    __setTestNotifier({
      isFocused: () => false,
      notify: (p) => calls.push(p),
    });
    await pushIfBackgrounded({ title: "Done", body: "ok", pieceId: "p1" });
    expect(calls).toEqual([{ title: "Done", body: "ok", pieceId: "p1" }]);
  });

  it("includes jobId when provided", async () => {
    const calls: unknown[] = [];
    __setTestNotifier({
      isFocused: () => false,
      notify: (p) => calls.push(p),
    });
    await pushIfBackgrounded({ title: "T", body: "B", jobId: "job-abc" });
    expect(calls[0]).toMatchObject({ title: "T", body: "B", jobId: "job-abc" });
  });
});
