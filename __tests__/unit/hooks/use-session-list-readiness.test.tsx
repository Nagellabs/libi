// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { AgentReadiness } from "@/lib/agents/agent-readiness";

/**
 * `POST /api/sessions` returning `500 {"error":"Authentication required"}` used
 * to vanish: `if (!res.ok) return null` (use-session-list.ts:143) and
 * `catch { return null }` (:163) discarded the server's own explanation, and the
 * only thing left for the UI to render was a disabled "+".
 *
 * These tests pin the two halves of the fix: the error text survives the call,
 * and readiness pushed over SSE reaches the hook.
 */

let broadcastHandler: ((data: Record<string, unknown>) => void) | null = null;

vi.mock("@/hooks/sessions/use-agent-chat", () => ({
  subscribeBroadcast: (handler: (data: Record<string, unknown>) => void) => {
    broadcastHandler = handler;
    return () => {
      broadcastHandler = null;
    };
  },
}));

const { useSessionList } = await import("@/hooks/sessions/use-session-list");

const EMPTY_SESSIONS = {
  sessions: [],
  activeAgentId: null,
  standbyReady: true,
};

function mockFetch(
  impl: (url: string, init?: RequestInit) => { status: number; body: unknown },
) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const { status, body } = impl(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  });
}

describe("useSessionList — failed session creation", () => {
  beforeEach(() => {
    broadcastHandler = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces the server's error message instead of discarding it", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url === "/api/sessions" && init?.method === "POST") {
          return { status: 500, body: { error: "Authentication required" } };
        }
        return { status: 200, body: EMPTY_SESSIONS };
      }),
    );

    const { result } = renderHook(() => useSessionList());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let outcome: { sessionId: string | null; error: string | null } | undefined;
    await act(async () => {
      outcome = await result.current.createSessionWithResult();
    });

    expect(outcome).toEqual({
      sessionId: null,
      error: "Authentication required",
    });
    await waitFor(() =>
      expect(result.current.createError).toBe("Authentication required"),
    );
    // The legacy signature still collapses to null for callers that only
    // branch on success.
    expect(outcome!.sessionId).toBeNull();
  });

  it("falls back to a concrete message when the server sends no error body", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url === "/api/sessions" && init?.method === "POST") {
          return { status: 503, body: {} };
        }
        return { status: 200, body: EMPTY_SESSIONS };
      }),
    );

    const { result } = renderHook(() => useSessionList());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let outcome: { sessionId: string | null; error: string | null } | undefined;
    await act(async () => {
      outcome = await result.current.createSessionWithResult();
    });

    expect(outcome!.error).toMatch(/HTTP 503/);
    expect(outcome!.error).not.toBe("");
  });
});

describe("useSessionList — readiness", () => {
  beforeEach(() => {
    broadcastHandler = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to `unknown` — it never claims health it has not observed", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({ status: 200, body: EMPTY_SESSIONS })),
    );
    const { result } = renderHook(() => useSessionList());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.readiness).toEqual({ state: "unknown" });
    expect(result.current.readinessFor("codex")).toEqual({ state: "unknown" });
  });

  it("adopts the readiness returned by GET /api/sessions", async () => {
    const readiness: AgentReadiness = {
      state: "needs-auth",
      agentId: "codex",
      message: "Codex needs to be signed in.",
      remedy: null,
    };
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({
        status: 200,
        body: { ...EMPTY_SESSIONS, activeAgentId: "codex", readiness },
      })),
    );

    const { result } = renderHook(() => useSessionList());
    await waitFor(() => expect(result.current.readiness.state).toBe("needs-auth"));
    expect(result.current.readinessFor("codex")).toEqual(readiness);
    // Readiness is per-agent — it must not leak onto a different one.
    expect(result.current.readinessFor("claude-code")).toEqual({
      state: "unknown",
    });
  });

  it("applies an `agent-readiness` SSE broadcast", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({
        status: 200,
        body: { ...EMPTY_SESSIONS, activeAgentId: "codex" },
      })),
    );
    const { result } = renderHook(() => useSessionList());
    await waitFor(() => expect(result.current.activeAgentId).toBe("codex"));
    expect(broadcastHandler).toBeTypeOf("function");

    const readiness: AgentReadiness = {
      state: "needs-auth",
      agentId: "codex",
      message: "Codex needs to be signed in.",
      remedy: {
        label: "Sign in to Codex",
        command: "/path/to/codex login",
        detail: "Runs the Codex engine libi already ships.",
      },
    };
    act(() => {
      broadcastHandler!({ type: "agent-readiness", agentId: "codex", readiness });
    });

    await waitFor(() =>
      expect(result.current.readiness).toEqual(readiness),
    );
  });
});
