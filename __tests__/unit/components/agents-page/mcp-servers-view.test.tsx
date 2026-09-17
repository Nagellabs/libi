// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

/**
 * The extensions section of the libi MCP tab. Everything it reads comes from
 * mocked hooks: the real ones short-poll the MCP server and dependency routes.
 */

let serversLoading = false;
const updateMutate = vi.fn<(arg: unknown) => Promise<unknown>>(async () => ({}));
const useDeps = vi.fn<(id: string, opts?: { enabled?: boolean }) => unknown>((id) => ({
  data: depsById[id] ?? [],
  isLoading: false,
}));
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (m: string) => toastError(m), success: vi.fn() } }));

const servers = [
  { id: "libi", name: "Libi", description: "libi's own tools", bundled: true, requireApproval: false, installStatus: "installed", serverStatus: "up", noServer: false, enabled: true },
  { id: "whisper", name: "Whisper (local STT)", description: "Transcribe locally", bundled: true, requireApproval: false, installStatus: "pending", serverStatus: "unknown", noServer: true, enabled: true },
  { id: "local-music", name: "Local Music (ACE-Step)", description: "Music on-device", bundled: true, requireApproval: true, installStatus: "pending", serverStatus: "unknown", noServer: true, enabled: true },
  { id: "libi-export", name: "Canvas export (Chromium)", description: "Headless Chromium", bundled: true, requireApproval: false, installStatus: "pending", serverStatus: "unknown", noServer: true, enabled: true },
  // A stale row for a def since removed from the registry. The DB can still
  // carry it for a while; the view must neither render nor trip over it.
  { id: "fal-ai", name: "fal.ai", description: "gone", bundled: true, requireApproval: false, installStatus: "installed", serverStatus: "up", noServer: false, enabled: true },
];
const depsById: Record<string, unknown[]> = {
  "local-music": [
    { binary: "ace-step weights (7.7 GB)", installed: false, path: null, source: null, runtimeStatus: "pending" },
  ],
  "libi-export": [
    { binary: "chromium", installed: false, path: null, source: null, runtimeStatus: "pending", manualInstall: true },
  ],
  libi: [{ binary: "ffmpeg", installed: true, path: "/x/ffmpeg", source: "bundled", runtimeStatus: "installed" }],
};
vi.mock("@/lib/queries/mcp-servers", () => ({
  useMcpServers: () => ({ data: serversLoading ? undefined : servers, isLoading: serversLoading }),
  useUpdateMcpServer: () => ({ mutate: updateMutate, mutateAsync: updateMutate, isPending: false }),
  useMcpServerDependencies: (id: string, opts?: { enabled?: boolean }) => useDeps(id, opts),
  useRetryDependency: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, variables: null }),
  useResyncMcpServers: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useRetryMcpServer: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useRemoveExtension: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/queries/mcp-health", () => ({
  useMcpHealth: () => ({
    data: { ok: true, url: "http://127.0.0.1:3457/mcp", childStatus: "running", sessions: 0 },
    isLoading: false,
  }),
}));
// The extension rows read the active agent (approval is enforced only for Claude).
vi.mock("@/lib/editor-state-context", async (orig) => ({
  ...(await orig<typeof import("@/lib/editor-state-context")>()),
  useEditorState: () => ({ activeProviderId: null, agentProviders: [] }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/agents",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/analytics/client", () => ({ trackEvent: vi.fn() }));

import { McpServersView } from "@/components/agents-page/mcp-servers-view";
import {
  MCP_SCROLL_EVENT,
  setPendingMcpScroll,
  takePendingMcpScroll,
} from "@/lib/mcp-scroll-intent";

const wrap = (ui: ReactElement) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

/**
 * Run `fn` with the document reporting itself hidden. jsdom's
 * `visibilityState` is a getter on the prototype, so it is overridden and put
 * back rather than assigned. `useDocumentVisible` reads it through
 * `useSyncExternalStore`, i.e. at render — no event needs dispatching for a
 * component mounted inside the block.
 */
function withDocumentHidden(fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(
    Document.prototype,
    "visibilityState",
  );
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "hidden",
  });
  try {
    fn();
  } finally {
    delete (document as unknown as Record<string, unknown>).visibilityState;
    if (original) Object.defineProperty(Document.prototype, "visibilityState", original);
  }
}

beforeEach(() => {
  updateMutate.mockClear();
  useDeps.mockClear();
  toastError.mockClear();
  serversLoading = false;
  setPendingMcpScroll(undefined);
});

describe("libi extensions — the libi card", () => {
  it("has no Bundled or Custom section and no Add MCP button", () => {
    wrap(<McpServersView />);
    expect(screen.queryByText(/^Bundled$/)).toBeNull();
    expect(screen.queryByText(/^Custom$/)).toBeNull();
    expect(screen.queryByRole("button", { name: /add mcp/i })).toBeNull();
  });

  it("nests every extension inside the libi card, driven by the registry's kind", () => {
    wrap(<McpServersView />);
    const libi = screen.getByTestId("mcp-card-libi");
    expect(within(libi).getByTestId("extension-row-whisper")).toBeInTheDocument();
    expect(within(libi).getByTestId("extension-row-local-music")).toBeInTheDocument();
    expect(within(libi).getByTestId("extension-row-libi-export")).toBeInTheDocument();
  });

  it("neither renders nor crashes on a DB row whose def is gone", () => {
    wrap(<McpServersView />);
    expect(screen.queryByTestId("mcp-card-fal-ai")).toBeNull();
    expect(screen.queryByTestId("extension-row-fal-ai")).toBeNull();
  });

  it("gives an extension row an approval switch but no enable switch, and PATCHes on toggle", () => {
    wrap(<McpServersView />);
    const row = screen.getByTestId("extension-row-local-music");
    const approval = within(row).getByRole("switch", { name: /require approval/i });
    expect(approval).toBeInTheDocument();
    expect(within(row).queryByRole("switch", { name: /enable/i })).toBeNull();
    expect(within(row).queryByLabelText(/^enable$/i)).toBeNull();
    fireEvent.click(approval);
    expect(updateMutate).toHaveBeenCalledWith(
      { id: "local-music", requireApproval: false },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("renders dependency chips for an extension (no more isTier2 gate)", () => {
    wrap(<McpServersView />);
    expect(
      within(screen.getByTestId("extension-row-local-music")).getByText(/ace-step weights/),
    ).toBeInTheDocument();
  });

  it("renders the Chromium export extension as a row with its dependency chip", () => {
    wrap(<McpServersView />);
    const row = screen.getByTestId("extension-row-libi-export");
    expect(within(row).getByText(/Canvas export \(Chromium\)/)).toBeInTheDocument();
    expect(within(within(row).getByTestId("dependency-chips")).getByText("chromium")).toBeInTheDocument();
    // A dependency card, not a server: no enable switch, and the chip offers
    // the manual download.
    expect(within(row).queryByRole("switch", { name: /enable/i })).toBeNull();
    expect(within(row).getByRole("button", { name: /download/i })).toBeInTheDocument();
  });

  it("keeps the #mcp-<id> anchor on the card and every nested row so show_extension can scroll", () => {
    wrap(<McpServersView />);
    expect(document.querySelector("#mcp-libi")).not.toBeNull();
    expect(document.querySelector("#mcp-local-music")).not.toBeNull();
    expect(document.querySelector("#mcp-libi-export")).not.toBeNull();
  });

  it("shows every extension row with no search box and no whole-app restart button", () => {
    wrap(<McpServersView />);
    expect(screen.queryByPlaceholderText(/search extensions/i)).toBeNull();
    expect(screen.getByTestId("extension-row-whisper")).toBeInTheDocument();
    expect(screen.getByTestId("extension-row-local-music")).toBeInTheDocument();
    expect(screen.getByTestId("extension-row-libi-export")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /restart libi/i })).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("renders no action row when nothing has failed to install, so there is no blank gap", () => {
    wrap(<McpServersView />);
    expect(screen.queryByRole("button", { name: /resync/i })).toBeNull();
  });

  /**
   * These two used to pass `active={false}`, a prop `McpsSkillsPage` fed
   * `tab === "mcp"`. It could never be false in production: base-ui's
   * `Tabs.Panel` defaults to `keepMounted: false`, so this whole subtree is
   * unmounted while the Skills tab shows and there is nothing left to receive
   * a `false`. The prop is gone; document visibility — a hidden window,
   * a minimised app — is the gate that can actually fire, so that is what is
   * tested.
   */
  it("stops the dependency polls when nobody can see the window", () => {
    withDocumentHidden(() => {
      wrap(<McpServersView />);
      expect(useDeps).toHaveBeenCalled();
      for (const call of useDeps.mock.calls) {
        expect(call[1]).toEqual({ enabled: false });
      }
    });
  });

  it("keeps the dependency polls on while the window is visible", () => {
    wrap(<McpServersView />);
    expect(useDeps).toHaveBeenCalled();
    for (const call of useDeps.mock.calls) {
      expect(call[1]).toEqual({ enabled: true });
    }
  });

  it("toasts when the approval toggle fails, leaving the switch on the server's value", () => {
    wrap(<McpServersView />);
    const row = screen.getByTestId("extension-row-local-music");
    const approval = within(row).getByRole("switch", { name: /require approval/i });
    fireEvent.click(approval);
    const [, options] = updateMutate.mock.calls[0] as unknown as [
      unknown,
      { onError?: (err: unknown) => void },
    ];
    expect(options?.onError).toBeTypeOf("function");
    options.onError?.(new Error("Failed to update MCP server"));
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/Failed to update MCP server/));
    expect(approval).toHaveAttribute("aria-checked", "true");
  });

  it("shows a skeleton, never a spinner, while the rows load", () => {
    serversLoading = true;
    const { container } = wrap(<McpServersView />);
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(screen.queryByText(/loading/i)).toBeNull();
  });
});

/**
 * `libi.show_extension` with an extensionId. The live CustomEvent covers the case
 * where this tab is already open; the parked intent covers the one that used
 * to be a dead end — the user is on another tab, so this view
 * is UNMOUNTED (base-ui Tabs.Panel keepMounted:false), the event reaches no
 * listener, and the agent's "I've opened the card for you" was a lie.
 */
describe("show_extension — scrolling to a card", () => {
  beforeEach(() => {
    // jsdom implements no scrollIntoView at all.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("claims an intent parked before this view was mounted", async () => {
    setPendingMcpScroll("local-music");
    wrap(<McpServersView />);
    await waitFor(() =>
      expect(document.querySelector("#mcp-local-music")!.className).toMatch(/ring-2/),
    );
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    // Consumed: a later mount must not jump again.
    expect(takePendingMcpScroll()).toBeNull();
  });

  it("still answers the live event when the tab is already open", async () => {
    wrap(<McpServersView />);
    expect(document.querySelector("#mcp-whisper")!.className).not.toMatch(/ring-2/);
    fireEvent(
      window,
      new CustomEvent(MCP_SCROLL_EVENT, { detail: { mcpId: "whisper" } }),
    );
    await waitFor(() =>
      expect(document.querySelector("#mcp-whisper")!.className).toMatch(/ring-2/),
    );
  });

  it("highlights nothing when no intent was parked", async () => {
    wrap(<McpServersView />);
    await waitFor(() => expect(screen.getByTestId("mcp-card-libi")).toBeInTheDocument());
    expect(document.querySelector("#mcp-local-music")!.className).not.toMatch(/ring-2/);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  /**
   * The parked-intent hand-off was never the broken part — this effect
   * ran and did call `scrollIntoView` on the right element. What failed was
   * `behavior: "smooth"`: a smooth scroll is an ANIMATION, and a browser runs
   * no animation frames for a hidden document, so the scroll was dropped
   * whole. Measured on the running page: smooth moved a 2429 px scroller 0 px,
   * the default behaviour moved it to 774 px. Hidden is the ORDINARY case
   * here — the agent calls this while the user is looking somewhere else.
   */
  it("scrolls instantly when the page is hidden, because a smooth scroll would not run at all", async () => {
    setPendingMcpScroll("local-music");
    withDocumentHidden(() => {
      wrap(<McpServersView />);
    });
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "start",
    });
  });

  it("keeps the smooth scroll when the page is visible", async () => {
    setPendingMcpScroll("local-music");
    wrap(<McpServersView />);
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });
  });

  it("does not spend the highlight while the page is hidden", async () => {
    setPendingMcpScroll("local-music");
    withDocumentHidden(() => {
      wrap(<McpServersView />);
    });
    const card = () => document.querySelector("#mcp-local-music")!;
    await waitFor(() => expect(card().className).toMatch(/ring-2/));
    // Well past the 1.5 s the highlight lasts: it must still be there,
    // because nobody has seen it yet.
    await new Promise((r) => setTimeout(r, 1800));
    expect(card().className).toMatch(/ring-2/);
    // The user comes back to the tab — now the clock starts.
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(card().className).not.toMatch(/ring-2/), { timeout: 3000 });
  }, 10_000);
});
