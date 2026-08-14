import { describe, it, expect } from "vitest";
import {
  runWithToolCallContext,
  getCurrentToolCall,
  wrapRegisterToolWithContext,
} from "@/mcp/tool-call-context";

describe("tool-call context", () => {
  it("exposes the current tool call inside the run scope and null outside", async () => {
    expect(getCurrentToolCall()).toBeNull();
    const seen = await runWithToolCallContext("libi.whisper_download_model", { model: "base" }, async () => {
      // Async hop must preserve the context.
      await new Promise((r) => setTimeout(r, 1));
      return getCurrentToolCall();
    });
    expect(seen).toEqual({ toolName: "libi.whisper_download_model", args: { model: "base" } });
    expect(getCurrentToolCall()).toBeNull();
  });

  it("keeps concurrent tool calls isolated", async () => {
    const results = await Promise.all([
      runWithToolCallContext("libi.a", { x: 1 }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return getCurrentToolCall()?.toolName;
      }),
      runWithToolCallContext("libi.b", { x: 2 }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        return getCurrentToolCall()?.toolName;
      }),
    ]);
    expect(results).toEqual(["libi.a", "libi.b"]);
  });

  it("wrapRegisterToolWithContext threads name + handler args into the context", async () => {
    const calls: Array<unknown> = [];
    const fakeRegister = (...args: unknown[]) => {
      // Immediately invoke the (wrapped) handler like the MCP SDK would.
      const handler = args[args.length - 1] as (a: unknown, extra: unknown) => Promise<unknown>;
      calls.push(handler({ model: "tiny" }, {}));
      return undefined;
    };
    const wrapped = wrapRegisterToolWithContext(fakeRegister as never);
    wrapped("libi.whisper_download_model", { description: "d" }, async () => {
      return { ctx: getCurrentToolCall() };
    });
    const out = (await calls[0]) as { ctx: unknown };
    expect(out.ctx).toEqual({
      toolName: "libi.whisper_download_model",
      args: { model: "tiny" },
    });
  });
});
