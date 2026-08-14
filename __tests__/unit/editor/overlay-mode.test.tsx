// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

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
vi.mock("@/hooks/sessions/use-agent-chat", () => ({
  subscribeBroadcast: () => () => {},
}));

import {
  EditorStateProvider,
  useEditorState,
} from "@/lib/editor-state-context";
import type { InspectorGroup, InspectorOverlayKind } from "@/lib/overlays/inspector-fields";

const STORAGE_KEY = "libi:editor-state";

/** Exposes the per-overlay getter/setter to the test via renderHook. */
function setup() {
  const { result } = renderHook(() => useEditorState(), {
    wrapper: EditorStateProvider,
  });
  return {
    get: (p: string, o: string, k: InspectorOverlayKind): InspectorGroup =>
      result.current.getOverlayInspectorMode(p, o, k),
    set: (p: string, o: string, m: InspectorGroup): void =>
      result.current.setOverlayInspectorMode(p, o, m),
  };
}

describe("per-overlay inspector mode persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("set (piece, overlayA)=transform; get returns transform; sibling defaults to text", () => {
    const { get, set } = setup();

    act(() => set("p1", "overlayA", "transform"));
    expect(get("p1", "overlayA", "text")).toBe("transform");
    // overlayB never set → default for a text overlay is now "text" (first tab).
    expect(get("p1", "overlayB", "text")).toBe("text");
  });

  it("a stored 'style' group for an image overlay clamps to 'transform' (image has only transform)", () => {
    const { get, set } = setup();
    act(() => set("p1", "img1", "style"));
    // image has only the transform group — style is not available, so the read
    // clamps to the kind default (transform).
    expect(get("p1", "img1", "image")).toBe("transform");
    // but a text overlay reading the same stored value keeps style.
    expect(get("p1", "img1", "text")).toBe("style");
  });

  it("persists to localStorage under libi:editor-state", () => {
    const { set } = setup();
    act(() => set("p1", "o1", "style"));
    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string);
    expect(parsed.overlayInspectorModePieces.p1.o1).toBe("style");
  });
});
