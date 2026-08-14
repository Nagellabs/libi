import { describe, expect, it, vi } from "vitest";
import { wrapRegisterToolWithTracking } from "@/mcp/analytics";

describe("wrapRegisterToolWithTracking", () => {
  it("fires the tracker with the tool name and still calls the handler", async () => {
    const tracker = vi.fn();
    const handler = vi.fn().mockResolvedValue("ok");
    const calls: unknown[][] = [];
    const fakeRegister = (...args: unknown[]) => { calls.push(args); };

    const wrapped = wrapRegisterToolWithTracking(fakeRegister, tracker);
    wrapped("libi.create_scene", { description: "d" }, handler);

    // The registered handler is the last arg passed to fakeRegister.
    const registeredHandler = calls[0][2] as (...a: unknown[]) => Promise<unknown>;
    const result = await registeredHandler({ pieceId: "p" });

    expect(tracker).toHaveBeenCalledWith("libi.create_scene");
    expect(handler).toHaveBeenCalledOnce();
    expect(result).toBe("ok");
  });

  it("never lets a tracker error break the handler", async () => {
    const tracker = vi.fn(() => { throw new Error("boom"); });
    const handler = vi.fn().mockResolvedValue("ok");
    const calls: unknown[][] = [];
    const reg = (...args: unknown[]) => { calls.push(args); };

    const wrapped = wrapRegisterToolWithTracking(reg, tracker);
    wrapped("libi.x", {}, handler);
    const registeredHandler = calls[0][2] as (...a: unknown[]) => Promise<unknown>;
    await expect(registeredHandler({})).resolves.toBe("ok");
  });
});
