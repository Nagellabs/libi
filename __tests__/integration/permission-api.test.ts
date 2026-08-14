// __tests__/integration/permission-api.test.ts
//
// Verifies the two HTTP endpoints introduced by the approval-flow plan:
//
//   POST /api/sessions/[sessionId]/permission       — resolve a pending approval
//   GET  /api/sessions/permission-modes              — read saved per-agent modes
//   PATCH /api/sessions/permission-modes             — update one agent's mode
//
// The POST suite mocks SessionManager so we can plant a fake session with a
// pre-registered pending approval and observe the resolve fn + emitForSession
// call directly — no real ACP / process manager involvement.
//
// The mode endpoints exercise the real `getApprovalMode`/`setApprovalMode`
// helpers against an in-memory test DB, mirroring the pattern in
// `__tests__/unit/approval-settings.test.ts`. We mock SessionManager only to
// stub `applyApprovalModeToActiveSessions` (no active sessions in tests).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PendingApproval } from "@/lib/sessions/types";

// ---------------------------------------------------------------------------
// Shared mock state — declared at module scope so each `vi.mock` factory can
// reach in. `vi.mock` is hoisted, so we use lazy getters via a holder object.
// ---------------------------------------------------------------------------

type FakeSession = {
  sessionId: string;
  agentId: string;
  pendingApprovals: Map<string, PendingApproval>;
};

const fakeSession: FakeSession = {
  sessionId: "s1",
  agentId: "claude-code",
  pendingApprovals: new Map(),
};

const emitForSession = vi.fn();
const applyApprovalModeToActiveSessions = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/sessions/session-manager", () => ({
  getSessionManager: () => ({
    getSession: (id: string) => (id === "s1" ? fakeSession : undefined),
    emitForSession,
    applyApprovalModeToActiveSessions,
  }),
}));

// Mock the mcp-config side import that session-manager touches in production
// — the route module never reaches it via our mock above, but Vitest still
// resolves the import graph on first require, so a stub keeps the chain quiet.
vi.mock("@/lib/mcp-config", () => ({
  getMcpServersForAcp: () => [],
  onMcpConfigInvalidated: () => {},
}));

import { POST } from "@/app/api/sessions/[sessionId]/permission/route";
import {
  GET as GET_MODES,
  PATCH as PATCH_MODES,
} from "@/app/api/sessions/permission-modes/route";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { getApprovalMode } from "@/lib/approval/settings";

// ---------------------------------------------------------------------------
// POST /api/sessions/[sessionId]/permission
// ---------------------------------------------------------------------------

describe("POST /api/sessions/[sessionId]/permission", () => {
  beforeEach(() => {
    fakeSession.pendingApprovals.clear();
    emitForSession.mockReset();
  });

  it("resolves the pending promise, deletes it, emits resolved event, and 200s", async () => {
    let resolved: unknown = null;
    fakeSession.pendingApprovals.set("p1", {
      pendingId: "p1",
      toolCall: {
        toolCallId: "t1",
        title: "Edit",
      } as PendingApproval["toolCall"],
      options: [
        {
          optionId: "opt-allow",
          name: "Allow",
          kind: "allow_once",
        },
        {
          optionId: "opt-reject",
          name: "Reject",
          kind: "reject_once",
        },
      ],
      resolve: (r) => {
        resolved = r;
      },
      createdAt: Date.now(),
    });

    const req = new Request("http://x/api/sessions/s1/permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pendingId: "p1", optionId: "opt-allow" }),
    });
    const res = await POST(req, {
      params: Promise.resolve({ sessionId: "s1" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(resolved).toEqual({
      outcome: { outcome: "selected", optionId: "opt-allow" },
    });
    expect(fakeSession.pendingApprovals.size).toBe(0);
    expect(emitForSession).toHaveBeenCalledWith("s1", {
      type: "agent-permission-resolved",
      pendingId: "p1",
      outcome: { kind: "selected", optionId: "opt-allow" },
    });
  });

  it("returns 404 when pending id is unknown", async () => {
    const req = new Request("http://x/api/sessions/s1/permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pendingId: "ghost", optionId: "opt-allow" }),
    });
    const res = await POST(req, {
      params: Promise.resolve({ sessionId: "s1" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "pending approval not found" });
  });

  it("returns 404 when sessionId is unknown", async () => {
    const req = new Request("http://x/api/sessions/unknown/permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pendingId: "p1", optionId: "opt-allow" }),
    });
    const res = await POST(req, {
      params: Promise.resolve({ sessionId: "unknown" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "session not found" });
  });

  it("returns 400 when pendingId or optionId is missing", async () => {
    const req1 = new Request("http://x/api/sessions/s1/permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optionId: "opt-allow" }),
    });
    const res1 = await POST(req1, {
      params: Promise.resolve({ sessionId: "s1" }),
    });
    expect(res1.status).toBe(400);

    const req2 = new Request("http://x/api/sessions/s1/permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pendingId: "p1" }),
    });
    const res2 = await POST(req2, {
      params: Promise.resolve({ sessionId: "s1" }),
    });
    expect(res2.status).toBe(400);
  });

  it("returns 400 when optionId doesn't match any offered option", async () => {
    let resolved: unknown = null;
    fakeSession.pendingApprovals.set("p1", {
      pendingId: "p1",
      toolCall: {
        toolCallId: "t1",
        title: "Edit",
      } as PendingApproval["toolCall"],
      options: [
        {
          optionId: "opt-allow",
          name: "Allow",
          kind: "allow_once",
        },
      ],
      resolve: (r) => {
        resolved = r;
      },
      createdAt: Date.now(),
    });

    const req = new Request("http://x/api/sessions/s1/permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pendingId: "p1", optionId: "fabricated" }),
    });
    const res = await POST(req, {
      params: Promise.resolve({ sessionId: "s1" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "optionId not in offered options",
    });
    // The pending promise must not be resolved on a rejected request.
    expect(resolved).toBeNull();
    expect(fakeSession.pendingApprovals.size).toBe(1);
  });

  it("returns 400 on invalid JSON body", async () => {
    const req = new Request("http://x/api/sessions/s1/permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await POST(req, {
      params: Promise.resolve({ sessionId: "s1" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON body" });
  });
});

// ---------------------------------------------------------------------------
// GET / PATCH /api/sessions/permission-modes
// ---------------------------------------------------------------------------

describe("/api/sessions/permission-modes", () => {
  beforeEach(() => {
    createTestDb();
    applyApprovalModeToActiveSessions.mockClear();
  });

  afterEach(() => {
    resetTestDb();
  });

  it("GET returns the saved modes map", async () => {
    // Plant two saved modes via the real settings helper.
    const { setApprovalMode } = await import("@/lib/approval/settings");
    setApprovalMode("claude-code", "ask");
    setApprovalMode("codex", "auto-with-generations");

    const res = await GET_MODES();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { modes: Record<string, string> };
    expect(body.modes).toEqual({
      "claude-code": "ask",
      codex: "auto-with-generations",
    });
  });

  it("PATCH 200s for valid input, persists the value, and broadcasts", async () => {
    const req = new Request("http://x/api/sessions/permission-modes", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "claude-code", mode: "ask" }),
    });
    const res = await PATCH_MODES(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // The new value is actually persisted.
    expect(getApprovalMode("claude-code")).toBe("ask");

    // SessionManager was told to broadcast for the right agent.
    expect(applyApprovalModeToActiveSessions).toHaveBeenCalledWith(
      "claude-code",
    );
  });

  it("PATCH 400s on invalid mode", async () => {
    const req = new Request("http://x/api/sessions/permission-modes", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "claude-code", mode: "bogus" }),
    });
    const res = await PATCH_MODES(req);
    expect(res.status).toBe(400);
    expect(applyApprovalModeToActiveSessions).not.toHaveBeenCalled();
  });

  it("PATCH 400s on missing agentId", async () => {
    const req = new Request("http://x/api/sessions/permission-modes", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "ask" }),
    });
    const res = await PATCH_MODES(req);
    expect(res.status).toBe(400);
    expect(applyApprovalModeToActiveSessions).not.toHaveBeenCalled();
  });

  it("PATCH 400s on invalid JSON body", async () => {
    const req = new Request("http://x/api/sessions/permission-modes", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{nope",
    });
    const res = await PATCH_MODES(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON body" });
  });
});
