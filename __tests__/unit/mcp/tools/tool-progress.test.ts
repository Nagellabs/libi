import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/mcp/notify", () => ({ notify: { toolProgress: vi.fn() } }));

import { notify } from "@/mcp/notify";
import { runWithToolCallContext } from "@/mcp/tool-call-context";
import { reportToolProgress, type ToolProgressExtra } from "@/mcp/tools/tool-progress";

const LINE = { progress: 5000, total: 20000, message: "sleeping — 5/20s" };
const asExtra = (x: unknown) => x as ToolProgressExtra;

describe("reportToolProgress", () => {
  beforeEach(() => vi.mocked(notify.toolProgress).mockClear());

  it("sends the MCP notification on the caller's token AND the job_progress side channel keyed by the running tool", async () => {
    const sendNotification = vi.fn(async () => {});
    await runWithToolCallContext("libi.sleep", { seconds: 20 }, () =>
      reportToolProgress(asExtra({ sendNotification, _meta: { progressToken: 7 } }), LINE),
    );
    expect(sendNotification).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: { progressToken: 7, progress: 5000, total: 20000, message: "sleeping — 5/20s" },
    });
    expect(notify.toolProgress).toHaveBeenCalledWith({
      toolName: "libi.sleep", toolArgs: { seconds: 20 }, done: 5000, total: 20000, message: "sleeping — 5/20s",
    });
  });

  it("still reaches the chat when the client sent no progressToken", async () => {
    const sendNotification = vi.fn(async () => {});
    await runWithToolCallContext("libi.sleep", { seconds: 20 }, () => reportToolProgress(asExtra({ sendNotification }), LINE));
    expect(sendNotification).not.toHaveBeenCalled();
    expect(notify.toolProgress).toHaveBeenCalledTimes(1);
  });

  it("keys the row by Claude's _meta['claudecode/toolUseId'] when the engine sent one", async () => {
    await runWithToolCallContext("libi.sleep", { seconds: 20 }, () =>
      reportToolProgress(asExtra({ _meta: { "claudecode/toolUseId": "toolu_01" } }), LINE),
    );
    expect(notify.toolProgress).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "toolu_01", toolName: "libi.sleep" }));
  });

  it("outside a tool handler and with no toolUseId, sends only the MCP notification", async () => {
    const sendNotification = vi.fn(async () => {});
    await reportToolProgress(asExtra({ sendNotification, _meta: { progressToken: "t" } }), LINE);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(notify.toolProgress).not.toHaveBeenCalled();
  });

  it("a rejected MCP notification never throws and never blocks the side channel", async () => {
    const sendNotification = vi.fn(async () => {
      throw new Error("stream closed");
    });
    await expect(
      runWithToolCallContext("libi.sleep", {}, () => reportToolProgress(asExtra({ sendNotification, _meta: { progressToken: 1 } }), LINE)),
    ).resolves.toBeUndefined();
    expect(notify.toolProgress).toHaveBeenCalledTimes(1);
  });
});
