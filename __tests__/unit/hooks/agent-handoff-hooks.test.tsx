// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

/**
 * Both hook halves of following a hand-off (lib/agents/agent-handoff.ts):
 *
 * - `useDispatchToAgent.send` from a page with no chat selects the new session,
 *   records the hand-off and goes to /editor (Task 13: Use on /templates
 *   applied the template and left the user on /templates with no chat);
 * - `useAgentHandoffFollow` (mounted in the app layout) turns a navigate event
 *   that beats the editor's mount into a parked event plus a push to /editor,
 *   and does nothing for any event that is not the hand-off's.
 */

class MockEventSource {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  close = vi.fn();
}
vi.stubGlobal("EventSource", MockEventSource);

const nav = vi.hoisted(() => ({ pathname: "/templates", push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push }),
  usePathname: () => nav.pathname,
}));

const editor = vi.hoisted(() => ({
  switchSession: vi.fn(),
  refresh: vi.fn(),
  toggleChat: vi.fn(),
  activeSessionId: null as string | null,
  chatVisible: false,
}));
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    sessionList: {
      switchSession: editor.switchSession,
      refresh: editor.refresh,
      activeSessionId: editor.activeSessionId,
    },
    chatVisible: editor.chatVisible,
    toggleChat: editor.toggleChat,
  }),
}));

const sendPrompt = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agents/send-prompt-to-agent", () => ({ sendPromptToAgent: sendPrompt }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { useDispatchToAgent } = await import("@/hooks/agent/use-dispatch-to-agent");
const { useAgentHandoffFollow } = await import("@/hooks/agent/use-agent-handoff-follow");
const { navigateEmitter } = await import("@/hooks/sessions/use-agent-chat");
const handoff = await import("@/lib/agents/agent-handoff");

/** What the real sendPromptToAgent does on a 200: hand the session id to onSession. */
function dispatchSucceeds(sessionId: string) {
  sendPrompt.mockImplementation(async (_p: string, opts: { onSession?: (id: string) => void }) => {
    opts.onSession?.(sessionId);
    return { ok: true, sessionId };
  });
}

beforeEach(() => {
  handoff.resetAgentHandoffForTests();
  nav.push.mockReset();
  nav.pathname = "/templates";
  editor.switchSession.mockReset();
  editor.toggleChat.mockReset();
  editor.activeSessionId = null;
  sendPrompt.mockReset();
});

describe("useDispatchToAgent.send", () => {
  it("from /templates: selects the new session, shows the chat, records the hand-off and goes to /editor", async () => {
    dispatchSucceeds("s-new");
    const { result } = renderHook(() => useDispatchToAgent());
    act(() => result.current.openWith("apply_template({ templateId: \"t1\", newPiece: {} })"));
    let sent = false;
    await act(async () => {
      sent = await result.current.send();
    });
    expect(sent).toBe(true);
    expect(editor.switchSession).toHaveBeenCalledWith("s-new");
    expect(editor.toggleChat).toHaveBeenCalledTimes(1);
    expect(nav.push).toHaveBeenCalledWith("/editor");
    expect(handoff.currentHandoff()).toMatchObject({ sessionId: "s-new", fromPath: "/templates" });
  });

  it("from /social (Ask the agent): the same", async () => {
    nav.pathname = "/social";
    dispatchSucceeds("s-ask");
    const { result } = renderHook(() => useDispatchToAgent());
    await act(async () => {
      await result.current.send();
    });
    expect(nav.push).toHaveBeenCalledWith("/editor");
    expect(handoff.currentHandoff()).toMatchObject({ sessionId: "s-ask", fromPath: "/social" });
  });

  it("from /editor: switches the session in place, with no navigation and no hand-off", async () => {
    nav.pathname = "/editor";
    dispatchSucceeds("s-new");
    const { result } = renderHook(() => useDispatchToAgent());
    await act(async () => {
      await result.current.send();
    });
    expect(editor.switchSession).toHaveBeenCalledWith("s-new");
    expect(nav.push).not.toHaveBeenCalled();
    expect(handoff.currentHandoff()).toBeNull();
  });

  it("goes nowhere when there is no in-app agent (bring-your-own CLI) or the send fails", async () => {
    const { result } = renderHook(() => useDispatchToAgent());
    sendPrompt.mockResolvedValueOnce({ ok: false, byoCli: true });
    await act(async () => {
      await result.current.send();
    });
    sendPrompt.mockResolvedValueOnce({ ok: false });
    await act(async () => {
      await result.current.send();
    });
    expect(nav.push).not.toHaveBeenCalled();
    expect(handoff.currentHandoff()).toBeNull();
  });
});

describe("useAgentHandoffFollow", () => {
  const OPEN = { target: "piece", pieceId: "p-applied" };

  it("parks the hand-off session's navigate for the editor and takes the user to /editor", () => {
    editor.activeSessionId = "s-new";
    handoff.beginHandoff({ sessionId: "s-new", fromPath: "/templates", at: Date.now() });
    renderHook(() => useAgentHandoffFollow());

    act(() => navigateEmitter.emit(OPEN));

    expect(nav.push).toHaveBeenCalledWith("/editor");
    expect(handoff.attachEditorNavigate().pending).toEqual(OPEN);
  });

  it("does not push again when the redirect already reached /editor (the editor just has not attached)", () => {
    nav.pathname = "/editor";
    editor.activeSessionId = "s-new";
    handoff.beginHandoff({ sessionId: "s-new", fromPath: "/templates", at: Date.now() });
    renderHook(() => useAgentHandoffFollow());

    act(() => navigateEmitter.emit(OPEN));

    expect(nav.push).not.toHaveBeenCalled();
    expect(handoff.attachEditorNavigate().pending).toEqual(OPEN);
  });

  it("never moves a user who handed nothing off", () => {
    editor.activeSessionId = "s-new";
    renderHook(() => useAgentHandoffFollow());
    act(() => navigateEmitter.emit(OPEN));
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("never moves a user for a hand-off whose session is no longer the selected one", () => {
    editor.activeSessionId = "s-other";
    handoff.beginHandoff({ sessionId: "s-new", fromPath: "/templates", at: Date.now() });
    renderHook(() => useAgentHandoffFollow());
    act(() => navigateEmitter.emit(OPEN));
    expect(nav.push).not.toHaveBeenCalled();
    expect(handoff.currentHandoff()).toBeNull();
  });

  it("leaves the event alone once the editor is attached", () => {
    editor.activeSessionId = "s-new";
    handoff.beginHandoff({ sessionId: "s-new", fromPath: "/templates", at: Date.now() });
    const { detach } = handoff.attachEditorNavigate();
    renderHook(() => useAgentHandoffFollow());
    act(() => navigateEmitter.emit(OPEN));
    expect(nav.push).not.toHaveBeenCalled();
    detach();
  });
});
