/**
 * POST /api/sessions/:id/restart — the chat's "Restart session". User-only: it takes the
 * browser-only checks (`browserOnlyRefusal`) like PATCH /api/sessions/permission-modes, so the
 * agent's own shell (a header-less loopback curl) cannot restart its chat — which would cancel its
 * own turn and reload itself — and another page cannot either. The loopback Host check every
 * `/api` request gets is the proxy's (`evaluateRequestOrigin`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() }));
vi.mock("@/lib/logger", () => ({ serverLogger: log, mcpLogger: log }));
const sm = vi.hoisted(() => ({ restartSession: vi.fn(), isRestarting: vi.fn(() => false) }));
vi.mock("@/lib/sessions/session-manager", () => ({ getSessionManager: () => sm }));

import { GET, POST } from "@/app/api/sessions/[sessionId]/restart/route";
import { SessionRestartError } from "@/lib/sessions/restart-error";

const CURL = { host: "127.0.0.1:3465", "content-type": "application/json" };
const BROWSER = { ...CURL, origin: "http://127.0.0.1:3465", "sec-fetch-site": "same-origin" };

const call = (headers: Record<string, string>, sessionId = "s1") =>
  POST(new Request(`http://127.0.0.1:3465/api/sessions/${sessionId}/restart`, { method: "POST", headers }), {
    params: Promise.resolve({ sessionId }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  sm.restartSession.mockResolvedValue({ agentId: "claude-code", processRestarted: false });
});

describe("POST /api/sessions/:id/restart", () => {
  it.each([
    ["the agent's shell (no browser headers)", CURL],
    ["a cross-site page", { ...BROWSER, "sec-fetch-site": "cross-site" }],
    ["another loopback origin", { ...BROWSER, origin: "http://127.0.0.1:9999" }],
    ["a typed URL (Sec-Fetch-Site none)", { ...BROWSER, "sec-fetch-site": "none" }],
  ])("refuses %s with 403 browser_only, and restarts nothing", async (_label, headers) => {
    const res = await call(headers);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("browser_only");
    expect(sm.restartSession).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ tag: "session-manager", op: "session_restart_refused" }), expect.any(String));
  });

  it("restarts the chat for libi's own page", async () => {
    const res = await call(BROWSER, "chat-9");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, processRestarted: false });
    expect(sm.restartSession).toHaveBeenCalledWith("chat-9");
  });

  it.each([
    ["not_found", 404],
    ["agent_busy", 409],
    ["load_failed", 502],
    ["agent_unresponsive", 504],
    ["timed_out", 504],
  ] as const)("a %s failure answers %i with the plain-words reason", async (code, status) => {
    sm.restartSession.mockRejectedValueOnce(new SessionRestartError(code, `reason for ${code}`));
    const res = await call(BROWSER);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: `reason for ${code}`, code });
  });

  it("recognises another bundle's copy of SessionRestartError (the manager is a globalThis singleton)", async () => {
    const foreign = Object.assign(new Error("reason from another bundle"), { name: "SessionRestartError", code: "agent_busy" });
    sm.restartSession.mockRejectedValueOnce(foreign);
    const res = await call(BROWSER);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "reason from another bundle", code: "agent_busy" });
  });

  it("an unexpected throw is a 500 that still says something readable", async () => {
    sm.restartSession.mockRejectedValueOnce(new Error("boom"));
    const res = await call(BROWSER);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/couldn't restart/i);
  });
});

describe("GET /api/sessions/:id/restart (C3)", () => {
  it("says whether a restart of the chat is under way, and starts nothing", async () => {
    sm.isRestarting.mockImplementation(((id: string) => id === "busy") as never);
    const get = (sessionId: string) =>
      GET(new Request(`http://127.0.0.1:3465/api/sessions/${sessionId}/restart`), { params: Promise.resolve({ sessionId }) });

    expect(await (await get("busy")).json()).toEqual({ restarting: true });
    expect(await (await get("idle")).json()).toEqual({ restarting: false });
    expect(sm.restartSession).not.toHaveBeenCalled();
  });
});
