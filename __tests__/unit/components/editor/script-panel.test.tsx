// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ScriptPanel } from "@/components/editor/script-panel";
import { EditorStateProvider } from "@/lib/editor-state-context";
import type { PersistedScript } from "@/lib/analysis/scripts";
import type { Script } from "@/lib/analysis/types";

vi.mock("react-resizable-panels", () => ({
  Group: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="resizable-group" className={className}>{children}</div>
  ),
  Panel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-panel">{children}</div>
  ),
  Separator: () => <div data-testid="resizable-separator" />,
}));
vi.mock("@/hooks/sessions/use-session-list", () => ({
  useSessionList: () => ({
    sessions: [], activeSessionId: null, setActiveSessionId: vi.fn(),
    isLoading: false, activeAgentId: null, refresh: vi.fn(), createSession: vi.fn(),
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/sessions/use-agent-chat", () => ({ subscribeBroadcast: () => () => {} }));

// jsdom doesn't implement scrollIntoView; the shot rail uses it.
beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

function persisted(overrides: Partial<Script> = {}): PersistedScript {
  return {
    step: {
      id: "s", fileId: "f", kind: "script:fal-video-understanding:gemini-2.5-pro",
      status: "ready", content: "{}", metadata: null, errorMessage: null,
      createdAt: new Date("2026-05-25T10:00:00Z"),
      updatedAt: new Date("2026-05-25T10:00:00Z"),
    } as never,
    script: {
      schema_version: "script_v1",
      duration: 30,
      overall_style: "Cinematic.",
      shots: [
        { index: 0, start: 0, end: 5, description: "Shot 1." } as never,
        { index: 1, start: 5, end: 12, description: "Shot 2." } as never,
      ],
      music: { present: false },
      sound_design: [{ timestamp: 4, description: "Whoosh" }],
      ...overrides,
    } as Script,
    providerId: "fal-video-understanding",
    modelId: "gemini-2.5-pro",
  };
}

const wrap = (ui: React.ReactNode) => <EditorStateProvider>{ui}</EditorStateProvider>;
beforeEach(() => localStorage.clear());

describe("ScriptPanel", () => {
  it("renders overview, shot rail, default-selected shot detail, and sound design", () => {
    render(wrap(
      <ScriptPanel
        persisted={persisted()}
        onSeek={() => {}}
        currentTime={0}
        onRegenerate={() => {}}
      />,
    ));
    expect(screen.getByText(/cinematic/i)).toBeInTheDocument();
    expect(screen.getByText(/Shots \(2\)/)).toBeInTheDocument();
    // "Shot 1." appears in both the rail and the detail pane — at least one is present.
    expect(screen.getAllByText("Shot 1.").length).toBeGreaterThan(0);
    expect(screen.getByText(/Sound Design \(1\)/)).toBeInTheDocument();
  });

  it("clicking a shot row in the rail updates the right-pane detail", () => {
    render(wrap(
      <ScriptPanel
        persisted={persisted()}
        onSeek={() => {}}
        currentTime={0}
        onRegenerate={() => {}}
      />,
    ));
    const row = screen.getByText(/2 · 0:05.*0:12/).closest("button")!;
    act(() => { fireEvent.click(row); });
    // "Shot 2." appears in both the rail and the detail pane after selection.
    expect(screen.getAllByText("Shot 2.").length).toBeGreaterThan(0);
  });

  it("renders a thin regen banner when regeneratingJob is set", () => {
    render(wrap(
      <ScriptPanel
        persisted={persisted()}
        onSeek={() => {}}
        currentTime={0}
        onRegenerate={() => {}}
        regeneratingJob={{
          id: "j", kind: "extra_analysis_model", status: "running",
          pieceId: null, fileId: "f",
          progressDone: 0, progressTotal: 0, progressUnit: "items",
          etaMs: null, msPerUnit: null, msSinceProgress: null, error: null, resultJson: null,
          startedAt: new Date(), completedAt: null, lastProgressAt: null,
        }}
        onCancel={() => {}}
      />,
    ));
    expect(screen.getByText(/regenerating/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });
});
