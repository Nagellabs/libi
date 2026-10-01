/**
 * A chat whose agent transcript is gone (`~/.claude/projects/…jsonl` deleted or cleaned, a Codex
 * rollout removed) used to show the adapter's raw "Resource not found: <id>". The classifier, the
 * session manager's typed error, and both routes' typed answers are covered here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import {
  ACP_RESOURCE_NOT_FOUND_CODE,
  AgentHistoryMissingError,
  HISTORY_MISSING_MESSAGE,
  isAgentHistoryMissingError,
} from "@/lib/sessions/history-missing";

const sm = {
  getSession: vi.fn((): unknown => ({ sessionId: "s-1", agentId: "claude-code" })),
  hasActiveSession: vi.fn(() => false),
  activateSession: vi.fn(async (): Promise<unknown[]> => []),
  sendMessage: vi.fn(async () => {}),
  markUserSent: vi.fn(),
  // The route's approval-mode gate: nothing in flight in these tests.
  awaitApprovalMode: vi.fn(async () => ({ ok: true as const })),
};
vi.mock("@/lib/sessions/session-manager", () => ({ getSessionManager: () => sm }));
vi.mock("@/lib/analytics/server", () => ({ trackServerEvent: vi.fn(async () => {}) }));

import { GET } from "@/app/api/agent/messages/route";
import { POST } from "@/app/api/agent/send/route";

beforeEach(() => {
  vi.clearAllMocks();
  sm.getSession.mockImplementation(() => ({ sessionId: "s-1", agentId: "claude-code" }));
  sm.hasActiveSession.mockImplementation(() => false);
});

describe("isAgentHistoryMissingError", () => {
  it("claude-agent-acp: RequestError.resourceNotFound(sessionId), by its code", () => {
    const err = RequestError.resourceNotFound("s-1");
    expect(err.code).toBe(ACP_RESOURCE_NOT_FOUND_CODE);
    expect(isAgentHistoryMissingError(err)).toBe(true);
    // The code alone decides: a transport that rewrites the message still classifies.
    expect(isAgentHistoryMissingError({ code: -32002, message: "whatever" })).toBe(true);
  });

  it("codex-acp: -32603 Internal error with the app-server's text in data.details", () => {
    // What codex-acp 1.10.0's errorToResult builds from a thread/resume rejection.
    const err = RequestError.internalError({ details: "no rollout found for thread id 019a-abc" });
    expect(err.code).toBe(-32603);
    expect(isAgentHistoryMissingError(err)).toBe(true);
    expect(
      isAgentHistoryMissingError(new RequestError(-32603, "no rollout found for conversation id 019a")),
    ).toBe(true);
  });

  it("everything else is not a missing history", () => {
    expect(isAgentHistoryMissingError(RequestError.authRequired())).toBe(false);
    expect(isAgentHistoryMissingError(RequestError.internalError({ details: "failed to load configuration" }))).toBe(false);
    expect(isAgentHistoryMissingError(new Error("Session s-1 not found"))).toBe(false);
    expect(isAgentHistoryMissingError(null)).toBe(false);
    expect(isAgentHistoryMissingError("Resource not found: s-1")).toBe(false);
  });

  it("the typed error carries the plain sentence, never the adapter's text", () => {
    const err = new AgentHistoryMissingError("s-1", { cause: RequestError.resourceNotFound("s-1") });
    expect(err.message).toBe(HISTORY_MISSING_MESSAGE);
    expect(err.message).not.toMatch(/resource not found/i);
  });
});

const getReq = () => new Request("http://127.0.0.1/api/agent/messages?sessionId=s-1");
const sendReq = () =>
  new Request("http://x/api/agent/send", { method: "POST", body: JSON.stringify({ sessionId: "s-1", text: "hi" }) });

describe("GET /api/agent/messages — history missing", () => {
  it("answers 200 { messages: [], historyMissing: true } instead of a 500 with the raw error", async () => {
    sm.activateSession.mockRejectedValueOnce(new AgentHistoryMissingError("s-1"));
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [], historyMissing: true, shellEnvLoaded: true });
  });

  it("recognises the error thrown by another bundle's copy of the class (no instanceof across route bundles)", async () => {
    // What the running dev server does: the singleton manager throws with ITS module copy's class.
    class ForeignCopy extends Error {
      constructor() {
        super(HISTORY_MISSING_MESSAGE);
        this.name = "AgentHistoryMissingError";
      }
    }
    sm.activateSession.mockRejectedValueOnce(new ForeignCopy());
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [], historyMissing: true, shellEnvLoaded: true });
  });

  it("any other activation failure is still a 500", async () => {
    sm.activateSession.mockRejectedValueOnce(new Error("adapter crashed"));
    const res = await GET(getReq());
    expect(res.status).toBe(500);
    expect((await res.json()).historyMissing).toBeUndefined();
  });
});

describe("POST /api/agent/send — history missing", () => {
  it("answers 409 { historyMissing: true } and never sends", async () => {
    sm.activateSession.mockRejectedValueOnce(new AgentHistoryMissingError("s-1"));
    const res = await POST(sendReq());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: HISTORY_MISSING_MESSAGE, historyMissing: true });
    expect(sm.sendMessage).not.toHaveBeenCalled();
  });

  it("recognises another bundle's copy of the error too", async () => {
    const foreign = Object.assign(new Error(HISTORY_MISSING_MESSAGE), { name: "AgentHistoryMissingError" });
    sm.activateSession.mockRejectedValueOnce(foreign);
    const res = await POST(sendReq());
    expect(res.status).toBe(409);
    expect(sm.sendMessage).not.toHaveBeenCalled();
  });
});
