// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { AgentStatus } from "@/lib/agents/agent-status";

/**
 * The Agents tab status bar: one row per agent (Installed · Signed in · Ready).
 * libi's global registration is optional and shows only on the Libi MCP tab. A row click opens the setup wizard at that agent's first
 * incomplete step; Set up again opens it at step 1. A status that could not be
 * read never renders as "not found" — it says so and offers Retry.
 */

let statuses: Partial<Record<string, AgentStatus>> | undefined;
let isLoading = false;
let isError = false;
let isFetching = false;
const refetch = vi.fn();
vi.mock("@/lib/queries/agent-status", () => ({
  useAllAgentStatus: () => ({ data: statuses, isLoading, isError, isFetching, refetch }),
}));
import { StatusBar } from "@/components/agents-page/agents-tab/status-bar";

const ready: AgentStatus = {
  agentId: "claude-code",
  cli: { path: "/u/claude", realPath: "/u/claude", version: "2.1.250", meetsMinimum: true },
  adapter: "ready",
  signIn: { confirmedAt: "2026-09-10T00:00:00.000Z", needsAuth: false },
  libiTools: { state: "connected", scope: "user" },
  ready: true,
};
const onOpen = vi.fn();
beforeEach(() => {
  onOpen.mockClear();
  refetch.mockClear();
  isLoading = false;
  isError = false;
  isFetching = false;
  statuses = { "claude-code": ready, codex: { ...ready, agentId: "codex" } };
});

describe("StatusBar", () => {
  it("renders one row per agent with Installed · Signed in · Ready, and no libi tools cell", () => {
    statuses = {
      "claude-code": ready,
      codex: { ...ready, agentId: "codex", cli: null, ready: false, libiTools: { state: "not-connected" }, signIn: { confirmedAt: null, needsAuth: false } },
    };
    render(<StatusBar onOpenWizard={onOpen} />);
    const claude = screen.getByTestId("agent-status-row-claude-code");
    expect(claude).toHaveTextContent("Claude Code");
    expect(within(claude).getByTestId("cell-installed")).toHaveTextContent("2.1.250");
    expect(within(claude).getByTestId("cell-signed-in")).toHaveTextContent("Confirmed");
    expect(within(claude).getByTestId("cell-ready")).toHaveTextContent("Ready");
    const codex = screen.getByTestId("agent-status-row-codex");
    expect(within(codex).getByTestId("cell-installed")).toHaveTextContent("not found");
    expect(within(codex).getByTestId("cell-signed-in")).toHaveTextContent("Not confirmed");
    expect(screen.queryByTestId("cell-libi-tools")).toBeNull();
    expect(screen.queryByText(/libi tools/i)).toBeNull();
    expect(within(codex).getByTestId("cell-ready")).toHaveTextContent("Not ready");
  });

  it("an observed auth rejection reads Needs sign-in; a below-minimum CLI reads update needed", () => {
    statuses = {
      "claude-code": { ...ready, signIn: { confirmedAt: "2026-09-10T00:00:00.000Z", needsAuth: true } },
      codex: { ...ready, agentId: "codex", cli: { path: "/c", realPath: "/c", version: "0.1.0", meetsMinimum: false }, ready: false, libiTools: { state: "stale-port" } },
    };
    render(<StatusBar onOpenWizard={onOpen} />);
    expect(within(screen.getByTestId("agent-status-row-claude-code")).getByTestId("cell-signed-in")).toHaveTextContent("Needs sign-in");
    const codex = screen.getByTestId("agent-status-row-codex");
    expect(within(codex).getByTestId("cell-installed")).toHaveTextContent("update needed (0.1.0)");
  });

  it("clicking a row opens the wizard at that agent's first incomplete step; Set up again opens step 1", () => {
    statuses = { "claude-code": { ...ready, signIn: { confirmedAt: null, needsAuth: false } }, codex: ready };
    render(<StatusBar onOpenWizard={onOpen} />);
    fireEvent.click(screen.getByTestId("agent-status-open-claude-code"));
    expect(onOpen).toHaveBeenCalledWith("claude-code", 3);
    fireEvent.click(within(screen.getByTestId("agent-status-row-codex")).getByRole("button", { name: /set up again/i }));
    expect(onOpen).toHaveBeenCalledWith("codex", 1);
    expect(onOpen).toHaveBeenCalledTimes(2); // Set up again does not ALSO fire the row's open
  });

  it("shows two skeleton rows, never a spinner, while loading", () => {
    isLoading = true;
    statuses = undefined;
    render(<StatusBar onOpenWizard={onOpen} />);
    expect(screen.getAllByTestId("agent-status-row-skeleton")).toHaveLength(2);
    expect(screen.queryByText(/loading/i)).toBeNull();
    expect(screen.queryByTestId("agent-status-row-claude-code")).toBeNull();
  });

  it("a failed status read says so and offers Retry — it never reads as not found", () => {
    isError = true;
    statuses = undefined;
    render(<StatusBar onOpenWizard={onOpen} />);
    const error = screen.getByTestId("agent-status-error");
    expect(error).toHaveTextContent("Couldn't read your agents' status.");
    expect(screen.queryByText("not found")).toBeNull();
    expect(screen.queryByTestId("agent-status-row-claude-code")).toBeNull();
    fireEvent.click(within(error).getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("an agent missing from the answer gets a couldn't-read row with Retry, and no open button", () => {
    statuses = { "claude-code": ready };
    render(<StatusBar onOpenWizard={onOpen} />);
    const codex = screen.getByTestId("agent-status-row-codex");
    expect(codex).toHaveTextContent("Couldn't read Codex's status");
    expect(within(codex).queryByTestId("cell-installed")).toBeNull();
    expect(screen.queryByTestId("agent-status-open-codex")).toBeNull();
    fireEvent.click(within(codex).getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(within(codex).getByRole("button", { name: /set up again/i })).toBeInTheDocument();
  });

  it("Retry is disabled and reads Retrying… while the refetch runs — a failed read stays failed until it answers", () => {
    isError = true;
    isFetching = true;
    statuses = undefined;
    const { rerender } = render(<StatusBar onOpenWizard={onOpen} />);
    const button = within(screen.getByTestId("agent-status-error")).getByRole("button", { name: /retrying/i });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(refetch).not.toHaveBeenCalled();
    isFetching = false;
    rerender(<StatusBar onOpenWizard={onOpen} />);
    expect(within(screen.getByTestId("agent-status-error")).getByRole("button", { name: /^retry$/i })).toBeEnabled();
  });

  it("the per-row Retry is disabled and reads Retrying… while the refetch runs", () => {
    statuses = { "claude-code": ready };
    isFetching = true;
    render(<StatusBar onOpenWizard={onOpen} />);
    const button = within(screen.getByTestId("agent-status-row-codex")).getByRole("button", { name: /retrying/i });
    expect(button).toBeDisabled();
    expect(within(screen.getByTestId("agent-status-row-codex")).getByRole("button", { name: /set up again/i })).toBeEnabled();
  });

  it("every button has cursor-pointer, and no button is nested inside another", () => {
    statuses = { "claude-code": ready };
    render(<StatusBar onOpenWizard={onOpen} />);
    for (const b of screen.getAllByRole("button")) {
      expect(b.className).toContain("cursor-pointer");
      expect(b.parentElement?.closest("button")).toBeNull();
    }
  });
});
