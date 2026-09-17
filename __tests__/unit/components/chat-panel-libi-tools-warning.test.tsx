// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { McpHealth } from "@/lib/queries/mcp-health";

/**
 * Without libi's MCP endpoint an agent silently has none of libi's tools, and
 * nothing else in the chat says so. The chat warns once the supervisor gave up
 * restarting the endpoint, and links to the libi MCP tab, where it can be
 * restarted. "stopped" happens only while libi shuts down, where that Restart
 * refuses, so it shows nothing — nor do a restart in flight, a status the server
 * cannot read, or a health read still loading. The chat polls health more slowly
 * than the Agents page: it only has to notice a give-up.
 */

const WARNING = "libi's tools are unavailable right now.";

let health: McpHealth | undefined;
const healthOptions = vi.fn();

function healthWith(childStatus: McpHealth["childStatus"]): McpHealth {
  return { ok: childStatus === "running", url: "http://127.0.0.1:3457/mcp", childStatus };
}

vi.mock("@/lib/queries/mcp-health", () => ({
  useMcpHealth: (opts: unknown) => {
    healthOptions(opts);
    return { data: health };
  },
}));
vi.mock("next/link", () => ({
  default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
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
    shellEnvLoaded: true,
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
  health = undefined;
  healthOptions.mockClear();
});

describe("ChatPanel — libi's tools unavailable", () => {
  it("a gave-up endpoint shows the warning with a link to restart it on the libi MCP tab", async () => {
    health = healthWith("gave-up");
    await mount("s-1");
    const banner = screen.getByTestId("libi-tools-unavailable-warning");
    expect(banner).toHaveTextContent(WARNING);
    const link = screen.getByRole("link", { name: "Restart in Agents" });
    expect(link).toHaveAttribute("href", "/agents?tab=libi-mcp");
    expect(link.className).toContain("cursor-pointer");
  });

  it("warns before a chat session exists too — the tools are missing either way", async () => {
    health = healthWith("gave-up");
    await mount(null);
    expect(screen.getByText(WARNING)).toBeInTheDocument();
  });

  it.each(["running", "restarting", "stopped", "unknown"] as const)("a %s endpoint shows nothing", async (childStatus) => {
    health = healthWith(childStatus);
    await mount("s-1");
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it("polls health at 30 s, not the Agents page's 5 s", async () => {
    await mount("s-1");
    expect(healthOptions).toHaveBeenCalled();
    for (const [opts] of healthOptions.mock.calls) expect(opts).toMatchObject({ refetchInterval: 30_000 });
  });

  it("shows nothing while the health read has not answered", async () => {
    health = undefined;
    await mount("s-1");
    expect(screen.queryByText(WARNING)).toBeNull();
  });
});
