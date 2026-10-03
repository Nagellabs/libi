/* eslint-disable @typescript-eslint/no-explicit-any -- decoded tool results are loosely typed JSON */
/**
 * The small pieces apply_ops leans on: held refreshes (notify), per-op analytics (the tracking wrapper's
 * suppression), the batch context, and the audio-clip handler's use of it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/libi-home", async (orig) => ({ ...(await orig<typeof import("@/lib/libi-home")>()), getCurrentPort: () => 4555 }));

import { holdRefreshQueries, notify } from "@/mcp/notify";
import { wrapRegisterToolWithTracking, withToolUsedSuppressed } from "@/mcp/analytics";
import { inBatchContext, runInBatchContext } from "@/mcp/tools/batch-context";

describe("holdRefreshQueries", () => {
  const realFetch = globalThis.fetch;
  let sent: any[];
  beforeEach(() => {
    sent = [];
    globalThis.fetch = vi.fn(async (_u: string, init?: { body?: string }) => {
      sent.push(JSON.parse(init!.body!));
      return new Response("{}");
    }) as never;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("holds refreshes made inside (through any await) and returns each distinct one once", async () => {
    const { result, refreshes } = await holdRefreshQueries(async () => {
      notify.refreshQuery({ queryKey: "composition", pieceId: "p1" });
      await Promise.resolve();
      notify.refreshQuery({ queryKey: "composition", pieceId: "p1" });
      notify.refreshQuery({ queryKey: "composition", pieceId: "p2" });
      notify.refreshQuery({ queryKey: "files", pieceId: "p1", fileId: "f" });
      return 7;
    });
    expect(result).toBe(7);
    expect(refreshes).toEqual([
      { queryKey: "composition", pieceId: "p1" },
      { queryKey: "composition", pieceId: "p2" },
      { queryKey: "files", pieceId: "p1", fileId: "f" },
    ]);
    expect(sent).toEqual([]);
  });

  it("sends as usual outside, and other notifications are never held", async () => {
    notify.refreshQuery({ queryKey: "composition", pieceId: "p1" });
    await holdRefreshQueries(async () => {
      notify.navigate({ target: "piece", pieceId: "p1" });
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(sent.map((s) => s.type).sort()).toEqual(["navigate", "refresh_query"]);
  });
});

describe("tool_used suppression", () => {
  it("the tracking wrapper reports a handler call, and stays silent inside withToolUsedSuppressed", async () => {
    const tracker = vi.fn();
    const handler = vi.fn(async () => "ok");
    const register = vi.fn();
    wrapRegisterToolWithTracking(register as never, tracker)("libi.update_overlay", {}, handler);
    const wrapped = register.mock.calls[0][2] as (a: unknown) => Promise<string>;
    await wrapped({});
    expect(tracker).toHaveBeenCalledTimes(1);
    await withToolUsedSuppressed(() => wrapped({}));
    expect(tracker).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(2);
    await wrapped({});
    expect(tracker).toHaveBeenCalledTimes(2);
  });
});

describe("batch context", () => {
  it("is on inside runInBatchContext, through awaits, and off outside", async () => {
    expect(inBatchContext()).toBe(false);
    await runInBatchContext(async () => {
      await Promise.resolve();
      expect(inBatchContext()).toBe(true);
    });
    expect(inBatchContext()).toBe(false);
  });
});
