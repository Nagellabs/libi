// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

// Runs under the REAL EditorStateProvider and the REAL useSessionList, so the
// assertion is on which chat is actually active afterwards — not on a spy.
// Only the edges are faked: the router, the shared EventSource (jsdom has
// none) and the HTTP responses.
const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => routerMock }));
vi.mock("@/hooks/sessions/use-agent-chat", () => ({
  subscribeBroadcast: () => () => {},
  setViewedSession: () => {},
}));

import { EditorStateProvider, useEditorState } from "@/lib/editor-state-context";
import { BackToChat } from "@/components/agents-page/back-to-chat";

const SESSIONS = [
  { sessionId: "sess-1", agentId: "claude-code", title: "Current chat", updatedAt: null, active: true },
  { sessionId: "sess-42", agentId: "claude-code", title: "The chat that sent you here", updatedAt: null, active: true },
];

function jsonResponse(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
}

beforeEach(() => {
  localStorage.clear();
  routerMock.push.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/sessions") return jsonResponse({ sessions: SESSIONS, activeAgentId: "claude-code" });
      if (url.startsWith("/api/agent/providers")) return jsonResponse([]);
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Shows what the editor would open, and lets the test put a chat on screen first. */
function Probe() {
  const { sessionList, lastSessionId } = useEditorState();
  return (
    <div>
      <span data-testid="loaded">{sessionList.sessions.length}</span>
      <span data-testid="active">{sessionList.activeSessionId ?? "none"}</span>
      <span data-testid="last">{lastSessionId ?? "none"}</span>
      <button type="button" onClick={() => sessionList.setActiveSessionId("sess-1")}>
        open sess-1
      </button>
    </div>
  );
}

async function renderWithActiveChat(from: string) {
  render(
    <EditorStateProvider>
      <Probe />
      <BackToChat sessionId={from} />
    </EditorStateProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("loaded")).toHaveTextContent(String(SESSIONS.length)));
  // The chat list outlives navigation, so a chat is usually already active
  // when the user comes back — that is exactly the case that must switch.
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "open sess-1" }));
  });
  expect(screen.getByTestId("active")).toHaveTextContent("sess-1");
}

describe("BackToChat", () => {
  it("switches the active chat to the one it came from, remembers it, and opens the editor", async () => {
    await renderWithActiveChat("sess-42");
    fireEvent.click(screen.getByRole("button", { name: /back to chat/i }));
    expect(screen.getByTestId("active")).toHaveTextContent("sess-42");
    expect(screen.getByTestId("last")).toHaveTextContent("sess-42");
    expect(routerMock.push).toHaveBeenCalledWith("/editor");
  });

  it("opens the editor without switching when the chat it came from no longer exists", async () => {
    await renderWithActiveChat("sess-gone");
    fireEvent.click(screen.getByRole("button", { name: /back to chat/i }));
    expect(screen.getByTestId("active")).toHaveTextContent("sess-1");
    expect(screen.getByTestId("last")).not.toHaveTextContent("sess-gone");
    expect(routerMock.push).toHaveBeenCalledWith("/editor");
  });
});
