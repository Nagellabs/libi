/**
 * POST /api/sessions/:id/forget — "Remove from list" on a chat whose history is gone (SES-4).
 * User-only, like Restart session: a header-less loopback caller (the agent's own shell) is refused,
 * libi's own page passes and reaches `SessionManager.forgetSession`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() }));
vi.mock("@/lib/logger", () => ({ serverLogger: log, mcpLogger: log }));
const sm = vi.hoisted(() => ({ forgetSession: vi.fn((): "forgotten" | "refused" | "not_found" => "forgotten") }));
vi.mock("@/lib/sessions/session-manager", () => ({ getSessionManager: () => sm }));

import { POST } from "@/app/api/sessions/[sessionId]/forget/route";

const CURL = { host: "127.0.0.1:3465", "content-type": "application/json" };
const BROWSER = { ...CURL, origin: "http://127.0.0.1:3465", "sec-fetch-site": "same-origin" };

const call = (headers: Record<string, string>, sessionId = "s1") =>
  POST(new Request(`http://127.0.0.1:3465/api/sessions/${sessionId}/forget`, { method: "POST", headers }), {
    params: Promise.resolve({ sessionId }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  sm.forgetSession.mockReturnValue("forgotten");
});

describe("POST /api/sessions/:id/forget", () => {
  it.each([
    ["the agent's shell (no browser headers)", CURL],
    ["a cross-site page", { ...BROWSER, "sec-fetch-site": "cross-site" }],
  ])("refuses %s with 403 browser_only, and removes nothing", async (_label, headers) => {
    const res = await call(headers);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("browser_only");
    expect(sm.forgetSession).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ tag: "session-manager", op: "session_forget_refused" }), expect.any(String));
  });

  it("removes the chat for libi's own page", async () => {
    const res = await call(BROWSER, "gone-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sm.forgetSession).toHaveBeenCalledWith("gone-1");
  });

  it("a chat whose history is there is refused (409), an unknown one is 404", async () => {
    sm.forgetSession.mockReturnValueOnce("refused");
    expect((await call(BROWSER)).status).toBe(409);
    sm.forgetSession.mockReturnValueOnce("not_found");
    expect((await call(BROWSER)).status).toBe(404);
  });
});
