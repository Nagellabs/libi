// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ScriptTabContent } from "@/components/editor/script-tab-content";
import { EditorStateProvider } from "@/lib/editor-state-context";
import type { PersistedScript } from "@/lib/analysis/scripts";
import type { JobStatusSnapshot } from "@/lib/jobs/types";

vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Separator: () => <div />,
}));
vi.mock("@/hooks/sessions/use-session-list", () => ({
  useSessionList: () => ({
    sessions: [], activeSessionId: null, setActiveSessionId: vi.fn(),
    isLoading: false, activeAgentId: null, refresh: vi.fn(), createSession: vi.fn(),
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/sessions/use-agent-chat", () => ({ subscribeBroadcast: () => () => {} }));
vi.mock("@/lib/queries/jobs", () => ({
  useCancelJob: () => ({ mutate: vi.fn() }),
}));

// jsdom doesn't implement scrollIntoView; ScriptShotRail uses it.
beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

const scriptMock = vi.hoisted(() => ({
  latest: undefined as PersistedScript | undefined,
  job: undefined as JobStatusSnapshot | undefined,
}));

vi.mock("@/lib/queries/scripts", () => ({
  useLatestScript: () => ({ data: scriptMock.latest, isLoading: false }),
  useScriptJob: () => ({ data: scriptMock.job, isLoading: false }),
}));

const wrap = (ui: React.ReactNode) => <EditorStateProvider>{ui}</EditorStateProvider>;
beforeEach(() => {
  localStorage.clear();
  scriptMock.latest = undefined;
  scriptMock.job = undefined;
});

function persistedScript(): PersistedScript {
  return {
    step: {
      id: "s", fileId: "f", kind: "script:fal-video-understanding:gemini-2.5-pro",
      status: "ready", content: "{}", metadata: null, errorMessage: null,
      createdAt: new Date(), updatedAt: new Date(),
    } as never,
    script: {
      schema_version: "script_v1",
      duration: 5,
      overall_style: "test",
      shots: [{ index: 0, start: 0, end: 5, description: "x" } as never],
      music: { present: false },
    } as never,
    providerId: "fal-video-understanding",
    modelId: "gemini-2.5-pro",
  };
}

const props = { fileId: "f", fileName: "my-clip.mp4", onSeek: () => {}, currentTime: 0 };

describe("ScriptTabContent state machine", () => {
  it("renders empty state when no script and no job", () => {
    render(wrap(<ScriptTabContent {...props} />));
    expect(screen.getByText(/hasn't been analyzed yet/i)).toBeInTheDocument();
  });

  it("opens the dispatch dialog with a script-specific prompt naming the file", () => {
    render(wrap(<ScriptTabContent {...props} />));
    fireEvent.click(screen.getByRole("button", { name: /generate ai analysis/i }));
    // The dialog shows the exact prompt handed to the agent — it must identify
    // the file (id + name) and the tool so the agent can act on it cold.
    const prompt = screen.getByText(/libi\.extra_analysis_model/);
    expect(prompt.textContent).toContain('file id: f');
    expect(prompt.textContent).toContain('"my-clip.mp4"');
    expect(screen.getByRole("button", { name: /send to libi agent/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy to clipboard/i })).toBeInTheDocument();
  });

  it("renders in-progress state when a job is running and no script exists yet", () => {
    scriptMock.job = {
      id: "j", kind: "extra_analysis_model", status: "running",
      pieceId: null, fileId: "f",
      progressDone: 2, progressTotal: 4, progressUnit: "step",
      etaMs: null, msPerUnit: null, error: null, resultJson: null,
      startedAt: new Date(), completedAt: null, lastProgressAt: null,
    };
    render(wrap(<ScriptTabContent {...props} />));
    expect(screen.getByText(/generating ai analysis/i)).toBeInTheDocument();
    expect(screen.getByText(/step 2 of 4/i)).toBeInTheDocument();
  });

  it("renders failed state when the latest job is failed and there's no script", () => {
    scriptMock.job = {
      id: "j", kind: "extra_analysis_model", status: "failed",
      pieceId: null, fileId: "f",
      progressDone: 0, progressTotal: 0, progressUnit: "items",
      etaMs: null, msPerUnit: null, error: "bad", resultJson: null,
      startedAt: new Date(), completedAt: new Date(), lastProgressAt: null,
    };
    render(wrap(<ScriptTabContent {...props} />));
    expect(screen.getByText(/ai analysis failed/i)).toBeInTheDocument();
  });

  it("renders the populated panel when a script exists", () => {
    scriptMock.latest = persistedScript();
    render(wrap(<ScriptTabContent {...props} />));
    expect(screen.getByText(/shots \(1\)/i)).toBeInTheDocument();
  });

  it("renders populated + regen banner when script exists AND job is running", () => {
    scriptMock.latest = persistedScript();
    scriptMock.job = {
      id: "j", kind: "extra_analysis_model", status: "running",
      pieceId: null, fileId: "f",
      progressDone: 1, progressTotal: 5, progressUnit: "items",
      etaMs: null, msPerUnit: null, error: null, resultJson: null,
      startedAt: new Date(), completedAt: null, lastProgressAt: null,
    };
    render(wrap(<ScriptTabContent {...props} />));
    expect(screen.getByText(/regenerating/i)).toBeInTheDocument();
  });
});
