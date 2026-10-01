/**
 * POST /api/agent/dispatch — a dispatched prompt to a new chat whose approval mode is held
 * (Ask or Auto, `set_mode` failed or never answered) is refused out loud: 503 naming the held
 * mode and the chat, never a 200 for a prompt `sendMessage` would drop.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ApprovalModeHeldError,
  DispatchChatTakenError,
  NoAgentConfiguredError,
} from "@/lib/agents/errors";

const dispatch = vi.hoisted(() => ({
  dispatchToAgent: vi.fn(async (): Promise<{ sessionId: string }> => ({ sessionId: "sess-1" })),
}));
vi.mock("@/lib/agents/dispatch", () => dispatch);

import { POST } from "@/app/api/agent/dispatch/route";

function req(body: unknown) {
  return new Request("http://x/api/agent/dispatch", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dispatch.dispatchToAgent.mockResolvedValue({ sessionId: "sess-1" });
});

describe("POST /api/agent/dispatch", () => {
  it("400 without a prompt", async () => {
    expect((await POST(req({ prompt: "  " }))).status).toBe(400);
    expect(dispatch.dispatchToAgent).not.toHaveBeenCalled();
  });

  it("200 with the new chat's id when the prompt went out", async () => {
    const r = await POST(req({ prompt: "make a thing" }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ success: true, sessionId: "sess-1" });
  });

  it("409 no_agent in bring-your-own-CLI mode", async () => {
    dispatch.dispatchToAgent.mockRejectedValue(new NoAgentConfiguredError());
    const r = await POST(req({ prompt: "make a thing" }));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "no_agent" });
  });

  it("held approval mode → 503 with approvalModeNotApplied and sessionId", async () => {
    const error = "libi couldn't apply 'Ask each time' to this chat in time, so the message wasn't sent.";
    dispatch.dispatchToAgent.mockRejectedValue(
      new ApprovalModeHeldError({ ok: false, mode: "ask", error, retryable: true }, "sess-held"),
    );
    const r = await POST(req({ prompt: "make a thing" }));
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({
      error,
      approvalModeNotApplied: "ask",
      sessionId: "sess-held",
    });
  });

  it("the user took the retried chat first → 503 with the reason and the chat, nothing sent", async () => {
    dispatch.dispatchToAgent.mockRejectedValue(new DispatchChatTakenError("sess-mine"));
    const r = await POST(req({ prompt: "make a thing" }));
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body.sessionId).toBe("sess-mine");
    expect(body.error).toMatch(/wasn't sent/);
  });
});
