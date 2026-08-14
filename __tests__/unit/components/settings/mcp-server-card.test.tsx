// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { McpServerCard } from "@/components/settings/mcp-server-card";
import type { McpServerUI } from "@/lib/queries/mcp-servers";

vi.mock("@/lib/queries/mcp-servers", () => ({
  useMcpServerDependencies: () => ({ data: [], isLoading: false }),
  useToggleMcpServer: () => ({ mutate: vi.fn() }),
  useToggleMcpApproval: () => ({ mutate: vi.fn() }),
  useUpdateMcpServer: () => ({ mutate: vi.fn() }),
  useDeleteMcpServer: () => ({ mutate: vi.fn() }),
  useRetryMcpServer: () => ({ mutate: vi.fn(), isPending: false }),
  useRetryDependency: () => ({ mutate: vi.fn(), isPending: false, variables: null }),
}));

// McpServerCard renders <McpSetupDialog>, which reads { activeProviderId,
// agentProviders } from useEditorState. Stub the hook so the card can render
// without the full EditorStateProvider (which itself needs a router + query
// client). Keep the module's other exports intact.
vi.mock("@/lib/editor-state-context", async (orig) => {
  const actual = await orig<typeof import("@/lib/editor-state-context")>();
  return {
    ...actual,
    useEditorState: () => ({ activeProviderId: null, agentProviders: [] }),
  };
});

// McpSetupDialog → useSetupWithAgent → useRouter(), which needs Next's
// app-router context. Stub next/navigation so the card renders in isolation.
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

// Deliberately-partial fixture: the card only reads the fields below, so the
// remaining McpServerUI fields are omitted and the cast bridges the gap.
function tier2Server(over: Partial<McpServerUI> = {}): McpServerUI {
  return {
    id: "youtube-downloader",
    name: "YouTube Downloader",
    description: "Download YouTube videos",
    bundled: true,
    enabled: true,
    type: "stdio" as const,
    command: "npx",
    args: "[]",
    npmUrl: null,
    serverStatus: "unknown" as const,
    serverError: null,
    installStatus: "not_installed" as const,
    installError: null,
    requireApproval: true,
    ...over,
  } as unknown as McpServerUI;
}

describe("McpServerCard — tier-2 in the npx-default model", () => {
  it("tier-2 + installed: shows the installed badge", () => {
    render(<McpServerCard server={tier2Server({ installStatus: "installed", serverStatus: "up" })} />);
    expect(screen.getByText(/installed/i)).toBeInTheDocument();
  });

  it("tier-2 + needs_config: shows needs_config + a Configure affordance", () => {
    render(<McpServerCard server={tier2Server({ installStatus: "needs_config" })} />);
    expect(screen.getByText(/needs.*config|configure/i)).toBeInTheDocument();
  });

  it("tier-2 + pending: does NOT show the 'On-demand' badge anymore", () => {
    render(<McpServerCard server={tier2Server({ installStatus: "pending" })} />);
    expect(screen.queryByText(/on-demand/i)).not.toBeInTheDocument();
  });

  it("tier-2 + failed: shows the failure badge (real problem worth surfacing)", () => {
    render(<McpServerCard server={tier2Server({ installStatus: "failed", installError: "ENOENT" })} />);
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
  });

  it("dependency chips stay hidden for tier-2 (agent-managed, no libi tokens)", () => {
    const { container } = render(<McpServerCard server={tier2Server({ installStatus: "installed" })} />);
    expect(container.querySelector('[data-testid="dependency-chips"]')).toBeNull();
  });
});
