// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { EditorStateProvider, useEditorState } from "@/lib/editor-state-context";

vi.mock("@/hooks/sessions/use-session-list", () => ({
  useSessionList: () => ({
    sessions: [],
    activeSessionId: null,
    setActiveSessionId: vi.fn(),
    isLoading: false,
    activeAgentId: null,
    refresh: vi.fn(),
    createSession: vi.fn(),
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/sessions/use-agent-chat", () => ({ subscribeBroadcast: () => () => {} }));

const STORAGE_KEY = "libi:editor-state";

function ZoomProbe() {
  const { previewTimelineZoom, setPreviewTimelineZoom } = useEditorState();
  return (
    <div>
      <span data-testid="zoom">{String(previewTimelineZoom)}</span>
      <button type="button" data-testid="set" onClick={() => setPreviewTimelineZoom(777)}>
        set
      </button>
    </div>
  );
}

describe("previewTimelineZoom persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("starts at null (Fit) even when localStorage holds a stale zoom", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ previewTimelineZoom: 950 }));
    render(
      <EditorStateProvider>
        <ZoomProbe />
      </EditorStateProvider>,
    );
    expect(screen.getByTestId("zoom")).toHaveTextContent("null");
  });

  it("keeps a set zoom in memory but never writes it to localStorage", () => {
    render(
      <EditorStateProvider>
        <ZoomProbe />
      </EditorStateProvider>,
    );
    act(() => {
      fireEvent.click(screen.getByTestId("set"));
    });
    expect(screen.getByTestId("zoom")).toHaveTextContent("777");
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored).not.toHaveProperty("previewTimelineZoom");
  });
});
