import { describe, it, expect, vi, beforeEach } from "vitest";

// A memory or instructions-override save is written to disk by the MCP child
// that served the agent's tool call, and `libi.read_manual` renders it fresh on
// every call. So the studio has nothing to apply and must never terminate the
// session that made the save (found 2026-10-02: `workspace.regenerate
// sessionsTerminated:1`, the chat ended "ACP connection closed" mid-turn).
const { terminateAll, resetAll, regenerateAndRestart } = vi.hoisted(() => ({
  terminateAll: vi.fn(async () => 1),
  resetAll: vi.fn(),
  regenerateAndRestart: vi.fn(async () => ({ sessionsTerminated: 1 })),
}));

vi.mock("@/lib/agents/process-manager", () => ({ getProcessManager: () => ({ terminateAll }) }));
vi.mock("@/lib/sessions/session-manager", () => ({
  getSessionManager: () => ({ resetAll, sessionForToolCall: () => null }),
}));
vi.mock("@/mcp/workspace", () => ({ regenerateAndRestart }));

import { POST } from "@/app/api/notify/route";

beforeEach(() => {
  terminateAll.mockClear();
  resetAll.mockClear();
  regenerateAndRestart.mockClear();
});

describe("/api/notify instructions_changed", () => {
  it("answers ok without terminating or resetting any session", async () => {
    const res = await POST(
      new Request("http://x/api/notify", {
        method: "POST",
        body: JSON.stringify({ type: "instructions_changed" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(terminateAll).not.toHaveBeenCalled();
    expect(resetAll).not.toHaveBeenCalled();
    expect(regenerateAndRestart).not.toHaveBeenCalled();
  });
});
