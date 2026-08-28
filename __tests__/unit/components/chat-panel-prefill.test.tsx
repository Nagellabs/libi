// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import ChatPanel from "@/components/chat/chat-panel";
import {
  EditorStateProvider,
  useEditorState,
} from "@/lib/editor-state-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// All the dep-mocks ChatPanel needs (most of these are inert no-ops; this
// test only asserts that prefilledMessage populates the textarea).
vi.mock("@/hooks/sessions/use-session-list", () => ({
  useSessionList: () => ({
    sessions: [], activeSessionId: null, setActiveSessionId: vi.fn(),
    isLoading: false, activeAgentId: null, refresh: vi.fn(), createSession: vi.fn(),
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/sessions/use-agent-chat", () => ({
  useAgentChat: () => ({
    messages: [], sendMessage: vi.fn(), isStreaming: false,
    cancelStream: vi.fn(), error: null, isLoading: false,
    sessionReady: false, cancelMessage: vi.fn(), status: "idle",
  }),
  subscribeBroadcast: () => () => {},
  sessionContextEmitter: { on: () => () => {}, emit: vi.fn() },
  // The model picker's query hook subscribes to this at mount; a partial mock
  // of this module has to carry it or every ChatPanel render throws.
  sessionModelEmitter: { on: () => () => {}, emit: vi.fn() },
}));
vi.mock("@/lib/queries/pieces", () => ({
  usePieces: () => ({ data: { pieces: [], openedPiece: null } }),
}));
vi.mock("@/lib/queries/files", () => ({
  useFiles: () => ({ data: [] }),
  useGlobalFiles: () => ({ data: [] }),
  useFileUpload: () => ({ upload: vi.fn() }),
}));

// `useRunRemedyInTerminal` reaches for the app router, which this render does
// not mount. It has its own tests; nothing here exercises it.
vi.mock("@/hooks/agents/use-run-remedy-in-terminal", () => ({
  useRunRemedyInTerminal: () => vi.fn(() => Promise.resolve()),
}));

vi.mock("@/hooks/use-scroll-to-bottom", () => ({
  useScrollToBottom: () => ({
    containerRef: { current: null },
    isAtBottom: true,
    scrollToBottom: vi.fn(),
    restoreSavedPosition: vi.fn(),
  }),
}));

function Trigger() {
  const { setPrefilledMessage } = useEditorState();
  return (
    <button onClick={() => setPrefilledMessage("Hello, script.")}>fire</button>
  );
}

beforeEach(() => localStorage.clear());

describe("ChatPanel prefill", () => {
  it("drops prefilledMessage into the composer textarea and clears it", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      <QueryClientProvider client={qc}>
        <EditorStateProvider>
          <Trigger />
          <ChatPanel sessionId={null} pieceId="" />
        </EditorStateProvider>
      </QueryClientProvider>,
    );
    const btn = screen.getByText("fire");
    act(() => { btn.click(); });
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("Hello, script.");
  });
});
