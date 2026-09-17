// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { McpServerCard } from "@/components/settings/mcp-server-card";
import type { McpServerUI } from "@/lib/queries/mcp-servers";

// Driven from a variable so the chip gate can be asserted with a real dep row.
let deps: Array<{ binary: string; installed: boolean; path: string | null; source: "bundled" | null }> =
  [];
const updateMutate = vi.fn();
const depsHook = vi.fn<(id: string, opts?: { enabled?: boolean }) => unknown>(() => ({
  data: deps,
  isLoading: false,
}));
const toastError = vi.fn();
const toastSuccess = vi.fn();
const removeMutate = vi.fn(async () => ({ freedBytes: 121_000_000 }));
vi.mock("sonner", () => ({
  toast: { error: (m: string) => toastError(m), success: (m: string) => toastSuccess(m) },
}));
vi.mock("@/lib/queries/mcp-servers", () => ({
  useMcpServerDependencies: (id: string, opts?: { enabled?: boolean }) => depsHook(id, opts),
  useUpdateMcpServer: () => ({ mutate: updateMutate }),
  useRetryMcpServer: () => ({ mutate: vi.fn(), isPending: false }),
  useRetryDependency: () => ({ mutate: vi.fn(), isPending: false, variables: null }),
  useRemoveExtension: () => ({ mutateAsync: removeMutate, isPending: false }),
}));

// McpServerCard renders <McpSetupDialog>, which reads { activeProviderId,
// agentProviders } from useEditorState. Stub the hook so the card can render
// without the full EditorStateProvider (which itself needs a router + query
// client). Keep the module's other exports intact.
// Also drives the Codex annotation on the approval switch, so the
// active agent is a variable rather than a constant `null`.
let activeProviderId: string | null = null;
vi.mock("@/lib/editor-state-context", async (orig) => {
  const actual = await orig<typeof import("@/lib/editor-state-context")>();
  return {
    ...actual,
    useEditorState: () => ({ activeProviderId, agentProviders: [] }),
  };
});

// libi's own card reports the aggregator's health (every tool on the page is
// served through that one endpoint). Drive it from a variable so the down
// state can be asserted without a QueryClient.
let health: { ok: boolean; error?: string } | undefined = {
  ok: true,
  error: undefined,
};
vi.mock("@/lib/queries/mcp-health", async (orig) => ({
  ...(await orig<typeof import("@/lib/queries/mcp-health")>()),
  useMcpHealth: () => ({ data: health, isLoading: false }),
}));

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
function extensionServer(over: Partial<McpServerUI> = {}): McpServerUI {
  return {
    id: "local-music",
    name: "Local Music (ACE-Step)",
    description: "Music on-device",
    bundled: true,
    enabled: true,
    type: "stdio" as const,
    command: "",
    args: "[]",
    npmUrl: null,
    serverStatus: "unknown" as const,
    serverError: null,
    installStatus: "pending" as const,
    installError: null,
    requireApproval: true,
    noServer: true,
    ...over,
  } as unknown as McpServerUI;
}

// The card's one production caller (mcp-servers-view) passes the core row;
// extensions are the nested rows. Badge states are covered on those rows.
const tier2Server = extensionServer;

/**
 * libi's extensions are rows nested inside the core card. Each
 * row carries its dependency chips (the `!isTier2` gate that hid them is
 * gone — since 2026-09-08 libi installs chromium and mediapipe-vision itself
 * on tier-2 defs, so hiding their state was hiding libi's own work and must
 * not come back), an approval switch, and NO enable switch.
 */
describe("McpServerCard — nested extension rows", () => {
  function libiServer(over: Partial<McpServerUI> = {}): McpServerUI {
    return tier2Server({
      id: "libi",
      name: "libi",
      installStatus: "installed",
      serverStatus: "up",
      noServer: false,
      ...over,
    });
  }

  it("renders dependency chips for an extension row", () => {
    deps = [{ binary: "chromium", installed: true, path: "/cache/chromium-1217/chrome", source: "bundled" }];
    try {
      render(
        <McpServerCard
          server={libiServer()}
          extensions={[extensionServer({ id: "libi-export", name: "Canvas export (Chromium)", installStatus: "installed" })]}
        />,
      );
      const row = screen.getByTestId("extension-row-libi-export");
      expect(row.querySelector('[data-testid="dependency-chips"]')).not.toBeNull();
      expect(within(row).getByText("chromium")).toBeInTheDocument();
    } finally {
      deps = [];
    }
  });

  it("gives every extension row an approval switch and no enable switch, and keeps the #mcp-<id> anchor", () => {
    const { container } = render(
      <McpServerCard server={libiServer()} extensions={[extensionServer(), extensionServer({ id: "whisper", name: "Whisper" })]} />,
    );
    const libi = screen.getByTestId("mcp-card-libi");
    const music = within(libi).getByTestId("extension-row-local-music");
    expect(within(music).getByRole("switch", { name: /require approval/i })).toBeInTheDocument();
    expect(within(music).queryByRole("switch", { name: /enable/i })).toBeNull();
    expect(container.querySelector('[id^="enabled-"]')).toBeNull();
    expect(container.querySelector("#mcp-local-music")).not.toBeNull();
    expect(container.querySelector("#mcp-whisper")).not.toBeNull();
    fireEvent.click(within(music).getByRole("switch", { name: /require approval/i }));
    expect(updateMutate).toHaveBeenCalledWith(
      { id: "local-music", requireApproval: false },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("the core card itself has no switches, and an empty extensions list renders no empty state of its own", () => {
    render(<McpServerCard server={libiServer()} extensions={[]} />);
    const libi = screen.getByTestId("mcp-card-libi");
    expect(within(libi).queryByRole("switch")).toBeNull();
    expect(within(libi).queryByText(/no extension matches/i)).toBeNull();
  });

  it("shows the install badge states on a nested row", () => {
    const { unmount } = render(
      <McpServerCard server={libiServer()} extensions={[extensionServer({ installStatus: "failed", installError: "ENOENT" })]} />,
    );
    expect(within(screen.getByTestId("extension-row-local-music")).getByText(/failed/i)).toBeInTheDocument();
    unmount();
    render(
      <McpServerCard server={libiServer()} extensions={[extensionServer({ installStatus: "needs_config" })]} />,
    );
    expect(within(screen.getByTestId("extension-row-local-music")).getByText(/needs.*config/i)).toBeInTheDocument();
    expect(screen.queryByText(/on-demand/i)).toBeNull();
  });

  it("passes polling=false down to every dependency hook as enabled: false", () => {
    depsHook.mockClear();
    render(
      <McpServerCard server={libiServer()} extensions={[extensionServer(), extensionServer({ id: "whisper", name: "Whisper" })]} polling={false} />,
    );
    expect(depsHook).toHaveBeenCalled();
    for (const call of depsHook.mock.calls) {
      expect(call[1]).toEqual({ enabled: false });
    }
  });

  it("defaults polling to enabled so other callers are unchanged", () => {
    depsHook.mockClear();
    render(<McpServerCard server={libiServer()} extensions={[extensionServer()]} />);
    expect(depsHook).toHaveBeenCalled();
    for (const call of depsHook.mock.calls) {
      expect(call[1]).toEqual({ enabled: true });
    }
  });

  it("toasts when the approval PATCH fails and the switch stays on the server's value", () => {
    updateMutate.mockClear();
    toastError.mockClear();
    render(<McpServerCard server={libiServer()} extensions={[extensionServer({ requireApproval: true })]} />);
    const sw = within(screen.getByTestId("extension-row-local-music")).getByRole("switch", { name: /require approval/i });
    fireEvent.click(sw);
    const [, options] = updateMutate.mock.calls[0] as [unknown, { onError?: (err: unknown) => void }];
    expect(options?.onError).toBeTypeOf("function");
    options.onError?.(new Error("Failed to update MCP server"));
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/Failed to update MCP server/));
    expect(sw).toHaveAttribute("aria-checked", "true");
  });

  // ── the approval switch is Claude-only, and used to say otherwise ──
  it("marks the approval switch as unenforced when Codex is the active agent", () => {
    activeProviderId = "codex";
    render(<McpServerCard server={libiServer()} extensions={[extensionServer()]} />);
    const row = screen.getByTestId("extension-row-local-music");
    expect(within(row).getByText(/not enforced on Codex/i)).toBeInTheDocument();
    // Annotated, NOT disabled: the setting is per-extension, not per-agent, so
    // it is still the user's real choice for their next Claude session.
    expect(within(row).getByRole("switch", { name: /require approval/i })).toBeEnabled();
    activeProviderId = null;
  });

  it("says nothing when Claude is active, or when no agent has resolved yet", () => {
    for (const id of ["claude-code", null]) {
      activeProviderId = id;
      const { unmount } = render(
        <McpServerCard server={libiServer()} extensions={[extensionServer()]} />,
      );
      expect(screen.queryByText(/not enforced on Codex/i)).not.toBeInTheDocument();
      unmount();
    }
    activeProviderId = null;
  });

  // ── no way to reclaim extension disk ─────────────────────────────
  it("offers Remove on an installed extension, and confirms before deleting", async () => {
    removeMutate.mockClear();
    toastSuccess.mockClear();
    render(
      <McpServerCard
        server={libiServer()}
        extensions={[extensionServer({ id: "local-tts", name: "Local TTS (Kokoro)", installStatus: "installed" })]}
      />,
    );
    const row = screen.getByTestId("extension-row-local-tts");
    fireEvent.click(within(row).getByRole("button", { name: /^remove$/i }));
    // Nothing is deleted on the first click — a confirmation stands in front.
    expect(removeMutate).not.toHaveBeenCalled();
    expect(screen.getByText(/Remove Local TTS \(Kokoro\)\?/i)).toBeInTheDocument();

    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^remove$/i }));
    expect(removeMutate).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/freed 121 MB/i)),
    );
  });

  it("offers no Remove for a not-yet-installed extension, nor for a shared-dep one", () => {
    render(
      <McpServerCard
        server={libiServer()}
        extensions={[
          // installed, but everything it owns is shared (chromium)
          extensionServer({ id: "libi-export", name: "Canvas export", installStatus: "installed" }),
          // removable in principle, but there is nothing on disk yet
          extensionServer({ id: "whisper", name: "Whisper", installStatus: "pending" }),
        ]}
      />,
    );
    for (const id of ["libi-export", "whisper"]) {
      const row = screen.getByTestId(`extension-row-${id}`);
      expect(within(row).queryByRole("button", { name: /^remove$/i })).not.toBeInTheDocument();
    }
  });

  it("shows the server line with Retry for a down extension that has a server (no tier-2 gate)", () => {
    render(
      <McpServerCard
        server={libiServer()}
        extensions={[
          extensionServer({ id: "libi-tracking", name: "Libi Tracking", noServer: false, installStatus: "installed", serverStatus: "down" }),
        ]}
      />,
    );
    const row = screen.getByTestId("extension-row-libi-tracking");
    expect(within(row).getByText("down")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

/**
 * The chip that replaced "BYO-CLI only". That old chip described a retired
 * per-folder stdio setup, and — worse — it fired for every HTTP MCP, which is
 * now every upstream libi aggregates. What a user needs on this page instead
 * is whether the single endpoint serving all of them is answering.
 */
describe("McpServerCard — the aggregator chip on libi's own card", () => {
  function libiServer(over: Partial<McpServerUI> = {}): McpServerUI {
    return tier2Server({
      id: "libi",
      name: "libi",
      bundled: true,
      installStatus: "installed",
      serverStatus: "up",
      ...over,
    });
  }

  it("shows 'aggregator down' on the libi card when health reports !ok", () => {
    health = { ok: false, error: "connect ECONNREFUSED 127.0.0.1:41234" };
    render(<McpServerCard server={libiServer()} />);
    expect(screen.getByText("aggregator down")).toBeInTheDocument();
  });

  it("shows nothing extra when the aggregator is healthy", () => {
    health = { ok: true };
    render(<McpServerCard server={libiServer()} />);
    expect(screen.queryByText("aggregator down")).toBeNull();
  });

  it("never shows the retired 'BYO-CLI only' chip on an HTTP server", () => {
    health = { ok: true };
    render(
      <McpServerCard
        server={tier2Server({ type: "http", url: "https://example.com/mcp" } as Partial<McpServerUI>)}
      />,
    );
    expect(screen.queryByText(/BYO-CLI only/)).toBeNull();
  });
});
