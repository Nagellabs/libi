// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SidebarProvider } from "@/components/ui/sidebar";

/**
 * "Restart session" from a chat row's right-click menu: offered for an agent chat (Claude Code,
 * Codex), below Copy session ID; while it runs the ROW names the wait ("Restarting…", with a
 * spinner); a failure is said in plain words (the server's reason) in a toast.
 */

let activeProviderId = "claude-code";
vi.mock("@/hooks/sessions/use-agent-chat", () => ({
  usePendingApprovalCount: () => 0,
  useSessionGenerating: () => false,
  useSessionUnviewed: () => false,
}));
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    activeProviderId,
    isAgentConnecting: false,
    agentProviders: [],
    sessionList: {
      groups: [{ label: "Today", sessions: [{ sessionId: "chat-a", title: "Intro video" }, { sessionId: "chat-b", title: "Outro" }] }],
      isLoading: false,
      activeSessionId: "chat-a",
      switchSession: vi.fn(),
      readiness: { state: "ready" },
      canListSessions: true,
    },
  }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/editor", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/sessions/terminal-session-list", () => ({ default: () => <div data-testid="terminal-list" /> }));
const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

async function renderList() {
  const { default: List } = await import("@/components/sessions/sidebar-session-list");
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <SidebarProvider>
        <List />
      </SidebarProvider>
    </QueryClientProvider>,
  );
}

const row = (title: string) => {
  const li = screen.getByText(title).closest("li");
  if (!li) throw new Error(`no row for ${title}`);
  return li;
};
const openMenu = (title: string) => fireEvent.contextMenu(within(row(title)).getByRole("button"));

let finish: (res: Response) => void;
beforeEach(() => {
  vi.clearAllMocks();
  activeProviderId = "claude-code";
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }),
  });
  vi.spyOn(global, "fetch").mockImplementation(() => new Promise<Response>((r) => { finish = r; }));
});

describe("SidebarSessionList — Restart session", () => {
  it.each(["claude-code", "codex"])("is offered below Copy session ID for a %s chat", async (agent) => {
    activeProviderId = agent;
    await renderList();
    openMenu("Intro video");
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Copy session ID", "Restart session"]);
  });

  it("is not offered for a provider that is not an agent chat", async () => {
    activeProviderId = "some-other-provider";
    await renderList();
    openMenu("Intro video");
    expect(screen.queryByRole("menuitem", { name: "Restart session" })).toBeNull();
  });

  it("posts the restart for THAT chat, names the wait on its row until it answers, then clears it", async () => {
    await renderList();
    openMenu("Outro");
    fireEvent.click(screen.getByRole("menuitem", { name: "Restart session" }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/sessions/chat-b/restart", { method: "POST" }));
    await waitFor(() => expect(within(row("Outro")).getByText("Restarting…")).toBeInTheDocument());
    expect(within(row("Intro video")).queryByText("Restarting…")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull(); // the menu closed on click

    await act(async () => finish(new Response(JSON.stringify({ ok: true, processRestarted: false }), { status: 200 })));
    await waitFor(() => expect(within(row("Outro")).queryByText("Restarting…")).toBeNull());
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("says what went wrong, in the server's plain words, for a chat the user is not viewing", async () => {
    await renderList();
    openMenu("Outro");
    fireEvent.click(screen.getByRole("menuitem", { name: "Restart session" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const reason = "The agent isn't responding, and another chat is still working on it, so libi didn't restart it.";
    await act(async () => finish(new Response(JSON.stringify({ error: reason, code: "agent_busy" }), { status: 409 })));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't restart the chat", { description: reason }));
    expect(within(row("Outro")).queryByText("Restarting…")).toBeNull();
  });

  // F9 (final review): the toast lives on the mutation hook, not on each mutate() call, because
  // TanStack v5 runs a per-call onError only for the LAST mutate of an observer — a second restart
  // started while the first is running would swallow the first one's failure.
  it("the chat being viewed gets no toast — its failure is the in-chat note", async () => {
    await renderList();
    openMenu("Intro video"); // chat-a, the viewed chat
    fireEvent.click(screen.getByRole("menuitem", { name: "Restart session" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await act(async () => finish(new Response(JSON.stringify({ error: "nope", code: "load_failed" }), { status: 500 })));

    await waitFor(() => expect(within(row("Intro video")).queryByText("Restarting…")).toBeNull());
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("two restarts at once: an earlier one's failure is still said", async () => {
    const finishers = new Map<string, (res: Response) => void>();
    vi.mocked(global.fetch).mockImplementation((input) => new Promise<Response>((r) => { finishers.set(String(input), r); }));
    activeProviderId = "claude-code";
    await renderList();
    openMenu("Outro");
    fireEvent.click(screen.getByRole("menuitem", { name: "Restart session" }));
    openMenu("Intro video");
    fireEvent.click(screen.getByRole("menuitem", { name: "Restart session" }));
    await waitFor(() => expect(finishers.size).toBe(2));

    // The FIRST call (chat-b, not viewed) fails after the second one was started.
    await act(async () => finishers.get("/api/sessions/chat-b/restart")!(new Response(JSON.stringify({ error: "Outro failed" }), { status: 500 })));
    await act(async () => finishers.get("/api/sessions/chat-a/restart")!(new Response(JSON.stringify({ processRestarted: false }), { status: 200 })));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't restart the chat", { description: "Outro failed" }));
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
