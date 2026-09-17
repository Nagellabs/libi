import { describe, it, expect, vi, beforeEach } from "vitest";
const setSignInConfirmed = vi.fn((_: string, at?: Date) => at ?? new Date("2026-09-10T12:00:00Z"));
vi.mock("@/lib/agents/sign-in-confirmation", () => ({ setSignInConfirmed: (a: string, at?: Date) => setSignInConfirmed(a, at) }));
const forgetObservedAuthFailure = vi.fn();
vi.mock("@/lib/sessions/session-manager", () => ({
  getSessionManager: () => ({ forgetObservedAuthFailure: (id: string) => forgetObservedAuthFailure(id) }),
}));
import { POST } from "@/app/api/agents/[agentId]/sign-in-confirmation/route";

const params = (agentId: string) => ({ params: Promise.resolve({ agentId }) });

describe("POST /api/agents/[agentId]/sign-in-confirmation", () => {
  beforeEach(() => {
    setSignInConfirmed.mockClear();
    forgetObservedAuthFailure.mockClear();
  });
  it("records the confirmation for a known agent and returns the timestamp", async () => {
    const res = await POST(new Request("http://localhost/x", { method: "POST" }), params("codex"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ confirmedAt: "2026-09-10T12:00:00.000Z" });
    expect(setSignInConfirmed).toHaveBeenCalledWith("codex", undefined);
  });
  it("lets the confirmation supersede an observed auth rejection, after it is written", async () => {
    await POST(new Request("http://localhost/x", { method: "POST" }), params("claude-code"));
    expect(forgetObservedAuthFailure).toHaveBeenCalledWith("claude-code");
    expect(setSignInConfirmed.mock.invocationCallOrder[0]).toBeLessThan(
      forgetObservedAuthFailure.mock.invocationCallOrder[0],
    );
  });
  it("refuses an unknown agent id", async () => {
    const res = await POST(new Request("http://localhost/x", { method: "POST" }), params("terminal"));
    expect(res.status).toBe(400);
    expect(setSignInConfirmed).not.toHaveBeenCalled();
    expect(forgetObservedAuthFailure).not.toHaveBeenCalled();
  });
});
