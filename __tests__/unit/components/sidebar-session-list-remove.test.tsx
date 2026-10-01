// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SidebarProvider } from "@/components/ui/sidebar";

/**
 * SES-4: a chat whose transcript is gone stays in the sidebar (libi's own chat index) and its menu
 * offers "Remove from list" instead of Restart session (a restart can't load a chat with no
 * history). Removing it posts the forget for THAT chat, refetches the list, and a removed chat that
 * was on screen hands the editor to the next one.
 */

const sessionList = vi.hoisted(() => ({
  groups: [
    {
      label: "Today",
      sessions: [
        { sessionId: "gone", title: "Beach video", historyMissing: true },
        { sessionId: "kept", title: "Outro", historyMissing: false },
        { sessionId: "unlisted", title: "Archived thread", historyMissing: false, unlisted: true },
      ],
    },
  ],
  isLoading: false,
  activeSessionId: "gone" as string | null,
  switchSession: vi.fn(),
  setActiveSessionId: vi.fn(),
  refresh: vi.fn(),
  readiness: { state: "ready" },
}));
vi.mock("@/hooks/sessions/use-agent-chat", () => ({
  usePendingApprovalCount: () => 0,
  useSessionGenerating: () => false,
  useSessionUnviewed: () => false,
}));
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({ activeProviderId: "claude-code", isAgentConnecting: false, agentProviders: [], sessionList }),
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

const openMenu = (title: string) => {
  const li = screen.getByText(title).closest("li");
  if (!li) throw new Error(`no row for ${title}`);
  fireEvent.contextMenu(within(li).getByRole("button"));
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionList.activeSessionId = "gone";
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }),
  });
  vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
});

describe("SidebarSessionList — a chat whose history is gone", () => {
  it("offers Remove from list, not Restart session", async () => {
    await renderList();
    openMenu("Beach video");
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Copy session ID", "Remove from list"]);
    expect(screen.getByRole("menuitem", { name: "Remove from list" })).toHaveClass("cursor-pointer");
  });

  it("an UNLISTED chat (not proven gone) keeps Restart session and also offers Remove from list", async () => {
    await renderList();
    openMenu("Archived thread");
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Copy session ID", "Restart session", "Remove from list"]);
  });

  it("a chat with its history keeps Restart session and gets no Remove", async () => {
    await renderList();
    openMenu("Outro");
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Copy session ID", "Restart session"]);
  });

  it("removes THAT chat, refetches the list, and moves the editor off it when it was on screen", async () => {
    await renderList();
    openMenu("Beach video");
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from list" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/sessions/gone/forget", { method: "POST" }));
    await waitFor(() => expect(sessionList.refresh).toHaveBeenCalledOnce());
    expect(sessionList.setActiveSessionId).toHaveBeenCalledWith("kept");
  });

  it("a refused removal is said in a toast, and the list is left alone", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Only a chat whose history is gone can be removed from the list." }), { status: 409 }),
    );
    await renderList();
    openMenu("Beach video");
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from list" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't remove the chat from the list", {
        description: "Only a chat whose history is gone can be removed from the list.",
      }),
    );
    expect(sessionList.refresh).not.toHaveBeenCalled();
  });
});
