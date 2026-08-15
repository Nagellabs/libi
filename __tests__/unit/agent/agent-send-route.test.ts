/**
 * POST /api/agent/send — the gate that used to strand sessions.
 *
 * After an agent switch-away-and-back, the session the chat panel displays is
 * persisted but INACTIVE; the route used to answer every send (and every
 * retry) with a dead-end `400 {"error":"No active session"}`. It now
 * re-activates a known-but-inactive session on demand via the one activation
 * path (`activateSession`, which dedupes concurrent activations), and only
 * hard-fails for sessions it has never heard of.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionEntry } from "@/lib/sessions/types";

const sm = {
  getSession: vi.fn<(id: string) => SessionEntry | undefined>(),
  hasActiveSession: vi.fn<(id: string) => boolean>(),
  activateSession: vi.fn(async () => []),
  sendMessage: vi.fn(async () => {}),
};
vi.mock("@/lib/sessions/session-manager", () => ({
  getSessionManager: () => sm,
}));
vi.mock("@/lib/analytics/server", () => ({
  trackServerEvent: vi.fn(async () => {}),
}));

import { POST } from "@/app/api/agent/send/route";

const SID = "sess-1";

function entryFor(sessionId: string): SessionEntry {
  return { sessionId, agentId: "claude-code" } as SessionEntry;
}

function req(body: unknown) {
  return new Request("http://x/api/agent/send", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sm.getSession.mockReturnValue(entryFor(SID));
  sm.hasActiveSession.mockReturnValue(true);
  sm.activateSession.mockResolvedValue([]);
  sm.sendMessage.mockResolvedValue(undefined);
});

describe("POST /api/agent/send", () => {
  it("returns 400 when sessionId or content is missing", async () => {
    expect((await POST(req({ text: "hi" }))).status).toBe(400);
    expect((await POST(req({ sessionId: SID }))).status).toBe(400);
  });

  it("returns 404 for a session the server has never heard of", async () => {
    sm.getSession.mockReturnValue(undefined);
    const r = await POST(req({ sessionId: "ghost", text: "hi" }));
    expect(r.status).toBe(404);
    expect(sm.activateSession).not.toHaveBeenCalled();
    expect(sm.sendMessage).not.toHaveBeenCalled();
  });

  it("sends without activating when the session is already active", async () => {
    const r = await POST(req({ sessionId: SID, text: "hi" }));
    expect(r.status).toBe(200);
    expect(sm.activateSession).not.toHaveBeenCalled();
    expect(sm.sendMessage).toHaveBeenCalledWith(SID, "hi");
  });

  it("re-activates a persisted-but-inactive session on demand, then sends (the agent-switch stranding fix)", async () => {
    sm.hasActiveSession.mockReturnValue(false);

    const r = await POST(req({ sessionId: SID, text: "hi again" }));

    expect(r.status).toBe(200);
    expect(sm.activateSession).toHaveBeenCalledWith(SID);
    expect(sm.sendMessage).toHaveBeenCalledWith(SID, "hi again");
    // Activation must complete BEFORE the send fires.
    expect(sm.activateSession.mock.invocationCallOrder[0]).toBeLessThan(
      sm.sendMessage.mock.invocationCallOrder[0],
    );
  });

  it("answers a failed re-activation with a retryable non-OK — and the retry succeeds once activation does", async () => {
    sm.hasActiveSession.mockReturnValue(false);
    sm.activateSession.mockRejectedValueOnce(new Error("loadSession failed"));

    // First attempt: activation fails → non-OK, nothing sent. The client
    // marks the message `sendFailed` and offers Retry.
    const first = await POST(req({ sessionId: SID, text: "precious words" }));
    expect(first.status).toBe(503);
    expect(sm.sendMessage).not.toHaveBeenCalled();

    // Retry: same sessionId, same route — succeeds now that activation does.
    // The old behaviour (an unconditional 400) made this loop forever.
    const retry = await POST(req({ sessionId: SID, text: "precious words" }));
    expect(retry.status).toBe(200);
    expect(sm.sendMessage).toHaveBeenCalledWith(SID, "precious words");
  });
});
