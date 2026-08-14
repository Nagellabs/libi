// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
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

beforeEach(() => {
  localStorage.clear();
});

describe("editor-state-context asset panel state", () => {
  it("defaults assetPanelSplit to 50 and getAssetViewMode returns 'split' for unknown ids", () => {
    const { result } = renderHook(() => useEditorState(), {
      wrapper: ({ children }) => <EditorStateProvider>{children}</EditorStateProvider>,
    });
    expect(result.current.assetPanelSplit).toBe(50);
    expect(result.current.getAssetViewMode("any-asset")).toBe("split");
  });

  it("setAssetPanelSplit persists to localStorage", () => {
    const { result } = renderHook(() => useEditorState(), {
      wrapper: ({ children }) => <EditorStateProvider>{children}</EditorStateProvider>,
    });
    act(() => result.current.setAssetPanelSplit(70));
    expect(result.current.assetPanelSplit).toBe(70);
    const stored = JSON.parse(localStorage.getItem("libi:editor-state")!);
    expect(stored.assetPanelSplit).toBe(70);
  });

  it("setAssetViewMode stores per-asset overrides", () => {
    const { result } = renderHook(() => useEditorState(), {
      wrapper: ({ children }) => <EditorStateProvider>{children}</EditorStateProvider>,
    });
    act(() => result.current.setAssetViewMode("video-1", "full"));
    expect(result.current.getAssetViewMode("video-1")).toBe("full");
    expect(result.current.getAssetViewMode("video-2")).toBe("split");
    const stored = JSON.parse(localStorage.getItem("libi:editor-state")!);
    expect(stored.assetViewModes).toEqual({ "video-1": "full" });
  });

  it("setAssetViewMode('split') drops the entry to keep storage minimal", () => {
    const { result } = renderHook(() => useEditorState(), {
      wrapper: ({ children }) => <EditorStateProvider>{children}</EditorStateProvider>,
    });
    act(() => result.current.setAssetViewMode("video-1", "full"));
    act(() => result.current.setAssetViewMode("video-1", "split"));
    expect(result.current.getAssetViewMode("video-1")).toBe("split");
    const stored = JSON.parse(localStorage.getItem("libi:editor-state")!);
    expect(stored.assetViewModes).toEqual({});
  });

  it("loads persisted values back from localStorage on mount", () => {
    localStorage.setItem(
      "libi:editor-state",
      JSON.stringify({
        chatVisible: true,
        resourcesVisible: true,
        panelSizes: { chat: 35, editor: 45, resources: 20 },
        assetPanelSplit: 65,
        assetViewModes: { "video-3": "full" },
      }),
    );
    const { result } = renderHook(() => useEditorState(), {
      wrapper: ({ children }) => <EditorStateProvider>{children}</EditorStateProvider>,
    });
    expect(result.current.assetPanelSplit).toBe(65);
    expect(result.current.getAssetViewMode("video-3")).toBe("full");
    expect(result.current.getAssetViewMode("video-other")).toBe("split");
  });

  it("persists lastPieceId / lastEditorTab / lastAssetId / lastSessionId", () => {
    const { result } = renderHook(() => useEditorState(), {
      wrapper: ({ children }) => <EditorStateProvider>{children}</EditorStateProvider>,
    });
    expect(result.current.lastPieceId).toBeNull();
    expect(result.current.lastEditorTab).toBe("preview");
    expect(result.current.lastAssetId).toBeNull();
    expect(result.current.lastSessionId).toBeNull();

    act(() => result.current.setLastPieceId("piece-1"));
    act(() => result.current.setLastEditorTab("assets"));
    act(() => result.current.setLastAssetId("file-9"));
    act(() => result.current.setLastSessionId("sess-7"));

    expect(result.current.lastPieceId).toBe("piece-1");
    expect(result.current.lastEditorTab).toBe("assets");
    expect(result.current.lastAssetId).toBe("file-9");
    expect(result.current.lastSessionId).toBe("sess-7");

    const stored = JSON.parse(localStorage.getItem("libi:editor-state")!);
    expect(stored.lastPieceId).toBe("piece-1");
    expect(stored.lastEditorTab).toBe("assets");
    expect(stored.lastAssetId).toBe("file-9");
    expect(stored.lastSessionId).toBe("sess-7");
  });

  it("persists and restores lastAssetTab", () => {
    const { result } = renderHook(() => useEditorState(), {
      wrapper: ({ children }) => <EditorStateProvider>{children}</EditorStateProvider>,
    });
    expect(result.current.lastAssetTab).toBe("summary");
    act(() => result.current.setLastAssetTab("transcript"));
    expect(result.current.lastAssetTab).toBe("transcript");
    const stored = JSON.parse(localStorage.getItem("libi:editor-state")!);
    expect(stored.lastAssetTab).toBe("transcript");
  });

  it("rehydrates last-opened fields from localStorage on mount", () => {
    localStorage.setItem(
      "libi:editor-state",
      JSON.stringify({
        chatVisible: true,
        resourcesVisible: true,
        panelSizes: { chat: 35, editor: 45, resources: 20 },
        assetPanelSplit: 50,
        assetViewModes: {},
        lastPieceId: "piece-restore",
        lastEditorTab: "objects",
        lastAssetId: "file-restore",
        lastAssetTab: "frames",
        lastSessionId: "sess-restore",
      }),
    );
    const { result } = renderHook(() => useEditorState(), {
      wrapper: ({ children }) => <EditorStateProvider>{children}</EditorStateProvider>,
    });
    expect(result.current.lastPieceId).toBe("piece-restore");
    expect(result.current.lastEditorTab).toBe("objects");
    expect(result.current.lastAssetId).toBe("file-restore");
    expect(result.current.lastAssetTab).toBe("frames");
    expect(result.current.lastSessionId).toBe("sess-restore");
  });

  it("ignores legacy assetFullMode field on read (drops it silently)", () => {
    localStorage.setItem(
      "libi:editor-state",
      JSON.stringify({
        chatVisible: true,
        resourcesVisible: true,
        panelSizes: { chat: 35, editor: 45, resources: 20 },
        assetPanelSplit: 50,
        assetFullMode: true, // old global flag — should be ignored
      }),
    );
    const { result } = renderHook(() => useEditorState(), {
      wrapper: ({ children }) => <EditorStateProvider>{children}</EditorStateProvider>,
    });
    expect(result.current.getAssetViewMode("any-asset")).toBe("split");
  });
});
