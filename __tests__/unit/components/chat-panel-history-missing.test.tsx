// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * A chat whose agent transcript is gone shows a plain explanation and a way out — never the
 * adapter's raw "Resource not found: <id>" — and its composer is disabled, so no send can loop on
 * the same refusal.
 */

const NOTE =
  "This chat's history isn't on this computer any more, so it can't be continued. Start a new chat to keep going.";

let historyMissing = false;
let messages: unknown[] = [];

vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    activeProviderId: "claude-code",
    isAgentConnecting: false,
    selectAgent: vi.fn(),
    agentProviders: [],
    agentProvidersLoaded: true,
    refreshAgentProviders: vi.fn(),
    prefilledMessage: null,
    setPrefilledMessage: vi.fn(),
    onboardingDemoOffer: false,
    setOnboardingDemoOffer: vi.fn(),
    viewMode: "editor",
    sessionList: {
      readiness: { state: "ready" },
      readinessFor: () => ({ state: "ready" }),
    },
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/sessions/use-agent-chat", () => ({
  useAgentChat: () => ({
    messages,
    sendMessage: vi.fn(),
    retryMessage: vi.fn(),
    isLoading: false,
    sessionReady: false,
    cancelMessage: vi.fn(),
    status: historyMissing ? "disconnected" : "connected",
    statusError: null,
    shellEnvLoaded: true,
    historyMissing,
  }),
  subscribeBroadcast: () => () => {},
  sessionContextEmitter: { on: () => () => {}, emit: vi.fn() },
  sessionModelEmitter: { on: () => () => {}, emit: vi.fn() },
}));
vi.mock("@/lib/queries/files", () => ({
  useFiles: () => ({ data: [] }),
  useGlobalFiles: () => ({ data: [] }),
  useFileUpload: () => ({ upload: vi.fn() }),
}));
vi.mock("@/lib/queries/session-context", () => ({
  useSessionContext: () => ({ commands: [], usage: null }),
}));
vi.mock("@/lib/queries/session-model", () => ({
  useSessionModel: () => ({ data: null, isLoading: false }),
  useSetSessionModel: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/lib/queries/plan-usage", () => ({
  usePlanUsage: () => ({ data: null }),
}));

async function mount(onNewChat?: () => void) {
  const { default: ChatPanel } = await import("@/components/chat/chat-panel");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <ChatPanel sessionId="s-gone" onNewChat={onNewChat} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  historyMissing = false;
  messages = [];
});

describe("ChatPanel — a chat whose history is gone", () => {
  it("says so plainly in place of the empty-chat prompt, and offers a new chat", async () => {
    historyMissing = true;
    const onNewChat = vi.fn();
    await mount(onNewChat);
    expect(screen.getByTestId("history-missing-note")).toHaveTextContent(NOTE);
    expect(screen.queryByText("Describe the video you want to create.")).toBeNull();
    expect(screen.queryByText(/resource not found/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it("disables the composer, so nothing can be sent into it", async () => {
    historyMissing = true;
    await mount(vi.fn());
    const input = screen.getByRole("textbox");
    expect(input).toBeDisabled();
  });

  it("keeps a failed send's bubble and puts the note under it", async () => {
    historyMissing = true;
    messages = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }], timestamp: 1, sendFailed: true },
    ];
    await mount(vi.fn());
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByTestId("history-missing-note")).toHaveTextContent(NOTE);
    // No Retry: it could only be refused the same way.
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("an ordinary empty chat is unchanged", async () => {
    await mount(vi.fn());
    expect(screen.queryByTestId("history-missing-note")).toBeNull();
    expect(screen.getByText("Describe the video you want to create.")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).not.toBeDisabled();
  });
});
