// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/** The exact copy. */
const WARNING =
  "libi couldn't load your shell environment (PATH and variables from your profile), so some tools may not work. If something doesn't work, restart libi.";

let shellEnvLoaded: boolean | undefined = true;

vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    activeProviderId: "codex",
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
    messages: [],
    sendMessage: vi.fn(),
    retryMessage: vi.fn(),
    isStreaming: false,
    cancelStream: vi.fn(),
    error: null,
    isLoading: false,
    sessionReady: true,
    cancelMessage: vi.fn(),
    status: "connected",
    shellEnvLoaded,
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

async function mount(sessionId: string | null) {
  const { default: ChatPanel } = await import("@/components/chat/chat-panel");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <ChatPanel sessionId={sessionId} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  shellEnvLoaded = true;
});

describe("ChatPanel — the shell-environment warning", () => {
  it("shows the exact warning at the TOP of a chat whose agent started before the environment loaded", async () => {
    shellEnvLoaded = false;
    await mount("s-1");
    const banner = screen.getByTestId("shell-env-warning");
    expect(banner).toHaveTextContent(WARNING);
    expect(banner.parentElement?.firstElementChild).toBe(banner);
  });

  it("shows nothing for a chat whose agent started with the environment — or before the server has answered", async () => {
    shellEnvLoaded = true;
    const view = await mount("s-1");
    expect(screen.queryByText(WARNING)).toBeNull();
    view.unmount();
    shellEnvLoaded = undefined;
    await mount("s-1");
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it("shows nothing without a session", async () => {
    shellEnvLoaded = false;
    await mount(null);
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it("terminal chats never show it: the editor mounts TerminalPanel, not ChatPanel, for a terminal chat", () => {
    const page = readFileSync(path.join(process.cwd(), "app/(app)/editor/page.tsx"), "utf8");
    expect(page).toMatch(/activeProviderId === "terminal"\s*\?\s*\(?\s*<TerminalPanel \/>\s*\)?\s*:\s*\(?\s*<ChatPanel/);
  });
});
