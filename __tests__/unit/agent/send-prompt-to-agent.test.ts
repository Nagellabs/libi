import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendPromptToAgent } from "@/lib/agents/send-prompt-to-agent";

describe("sendPromptToAgent", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("POSTs the prompt and calls onSession on success", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ sessionId: "s1" }), { status: 200 })) as never;
    const onSession = vi.fn();
    const r = await sendPromptToAgent("hello", { onSession });
    expect(r.ok).toBe(true);
    expect(r.sessionId).toBe("s1");
    expect(onSession).toHaveBeenCalledWith("s1");
  });

  it("409 → byoCli=true, does not call onSession", async () => {
    global.fetch = vi.fn(async () => new Response("", { status: 409 })) as never;
    const onSession = vi.fn();
    const r = await sendPromptToAgent("hello", { onSession });
    expect(r.byoCli).toBe(true);
    expect(r.ok).toBe(false);
    expect(onSession).not.toHaveBeenCalled();
  });

  it("network throw → ok:false", async () => {
    global.fetch = vi.fn(async () => { throw new Error("net"); }) as never;
    const r = await sendPromptToAgent("hello", {});
    expect(r.ok).toBe(false);
  });

  it("503 held approval mode → ok:false with the server's reason and the chat, no onSession", async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: "the reason", approvalModeNotApplied: "ask", sessionId: "s2" }),
        { status: 503 },
      ),
    ) as never;
    const onSession = vi.fn();
    const r = await sendPromptToAgent("hello", { onSession });
    expect(r).toEqual({ ok: false, error: "the reason", sessionId: "s2" });
    expect(onSession).not.toHaveBeenCalled();
  });

  it("a non-OK answer with no JSON body → ok:false, no error text", async () => {
    global.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as never;
    const r = await sendPromptToAgent("hello", {});
    expect(r).toEqual({ ok: false });
  });
});
