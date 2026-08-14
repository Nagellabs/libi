// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { EditorStateProvider, useEditorState } from "@/lib/editor-state-context";

vi.mock("@/hooks/sessions/use-session-list", () => ({
  useSessionList: () => ({
    sessions: [], activeSessionId: null, setActiveSessionId: vi.fn(),
    isLoading: false, activeAgentId: null, refresh: vi.fn(), createSession: vi.fn(),
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/sessions/use-agent-chat", () => ({
  subscribeBroadcast: () => () => {},
}));

// A tiny probe component that surfaces the new editor-state API.
function Probe() {
  const s = useEditorState();
  return (
    <div>
      <span data-testid="layers-split">{s.previewLayersSplit}</span>
      <span data-testid="layers-docked">{String(s.getPreviewLayersDocked("p1"))}</span>
      <span data-testid="locked">{String(s.getOverlayLocked("p1", "o1"))}</span>
      <span data-testid="chat-visible">{String(s.chatVisible)}</span>
      <span data-testid="resources-visible">{String(s.resourcesVisible)}</span>
      <span data-testid="effects-open">{String(s.effectsPanelOpen)}</span>
      <button data-testid="dock" onClick={() => s.setPreviewLayersDocked("p1", true)}>dock</button>
      <button data-testid="undock" onClick={() => s.setPreviewLayersDocked("p1", false)}>undock</button>
      <button data-testid="lock" onClick={() => s.setOverlayLocked("p1", "o1", true)}>lock</button>
      <button data-testid="split" onClick={() => s.setPreviewLayersSplit(40)}>split</button>
      <button data-testid="show-resources" onClick={() => s.toggleResources()}>res</button>
    </div>
  );
}

describe("editor-state layers additions", () => {
  beforeEach(() => window.localStorage.clear());

  it("new-user panel defaults: timeline + chat only (resources/layers/effects OFF)", () => {
    render(<EditorStateProvider><Probe /></EditorStateProvider>);
    // Focused default layout: only the always-on timeline panel + chat.
    expect(screen.getByTestId("chat-visible").textContent).toBe("true");
    expect(screen.getByTestId("resources-visible").textContent).toBe("false");
    expect(screen.getByTestId("effects-open").textContent).toBe("false");
    // No explicit preference ⇒ layers panel hidden by default (per-piece).
    expect(screen.getByTestId("layers-docked").textContent).toBe("false");
    expect(screen.getByTestId("locked").textContent).toBe("false");
    expect(Number(screen.getByTestId("layers-split").textContent)).toBeGreaterThan(0);
  });

  it("a user's Resources toggle persists (global carry-forward to future pieces/boots)", () => {
    render(<EditorStateProvider><Probe /></EditorStateProvider>);
    act(() => { screen.getByTestId("show-resources").click(); });
    expect(screen.getByTestId("resources-visible").textContent).toBe("true");
    const raw = JSON.parse(window.localStorage.getItem("libi:editor-state") as string);
    expect(raw.resourcesVisible).toBe(true);
  });

  it("an explicit dock (true) is preserved for that piece, overriding the hidden default", () => {
    render(<EditorStateProvider><Probe /></EditorStateProvider>);
    act(() => { screen.getByTestId("dock").click(); });
    expect(screen.getByTestId("layers-docked").textContent).toBe("true");
    const raw = JSON.parse(window.localStorage.getItem("libi:editor-state") as string);
    expect(raw.previewLayersDockedPieces.p1).toBe(true);
  });

  it("setters flip flags and persist to localStorage", () => {
    render(<EditorStateProvider><Probe /></EditorStateProvider>);
    act(() => { screen.getByTestId("dock").click(); });
    act(() => { screen.getByTestId("lock").click(); });
    act(() => { screen.getByTestId("split").click(); });
    expect(screen.getByTestId("layers-docked").textContent).toBe("true");
    expect(screen.getByTestId("locked").textContent).toBe("true");
    expect(screen.getByTestId("layers-split").textContent).toBe("40");
    const blob = JSON.parse(window.localStorage.getItem("libi:editor-state")!);
    expect(blob.previewLayersDockedPieces.p1).toBe(true);
    expect(blob.overlayLockedPieces.p1.o1).toBe(true);
    expect(blob.previewLayersSplit).toBe(40);
  });
});
