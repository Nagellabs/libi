// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { createElement } from "react";
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

// A tiny probe component that surfaces the overlaySizeSplit getter/setter.
function Probe() {
  const s = useEditorState();
  return createElement(
    "div",
    null,
    createElement("span", { "data-testid": "split" }, String(s.getOverlaySizeSplit("p1", "o1"))),
    createElement(
      "button",
      { "data-testid": "set-on", onClick: () => s.setOverlaySizeSplit("p1", "o1", true) },
      "on",
    ),
    createElement(
      "button",
      { "data-testid": "set-off", onClick: () => s.setOverlaySizeSplit("p1", "o1", false) },
      "off",
    ),
  );
}

function renderProbe() {
  return render(
    createElement(EditorStateProvider, null, createElement(Probe)),
  );
}

describe("overlaySizeSplitPieces editor-state memory", () => {
  beforeEach(() => window.localStorage.clear());

  it("getter defaults to false when no entry", () => {
    renderProbe();
    expect(screen.getByTestId("split").textContent).toBe("false");
  });

  it("after set(true) the getter returns true and persists to localStorage", () => {
    renderProbe();
    act(() => { screen.getByTestId("set-on").click(); });
    expect(screen.getByTestId("split").textContent).toBe("true");
    const blob = JSON.parse(window.localStorage.getItem("libi:editor-state")!);
    expect(blob.overlaySizeSplitPieces.p1.o1).toBe(true);
  });

  it("the value survives a serialize → deserialize round-trip", () => {
    // First mount: set the flag, which persists the blob.
    const first = renderProbe();
    act(() => { screen.getByTestId("set-on").click(); });
    expect(screen.getByTestId("split").textContent).toBe("true");
    first.unmount();

    // Second mount reads the persisted blob fresh — deserialize path.
    renderProbe();
    expect(screen.getByTestId("split").textContent).toBe("true");
  });

  it("set(false) clears the entry and the getter returns false again", () => {
    renderProbe();
    act(() => { screen.getByTestId("set-on").click(); });
    expect(screen.getByTestId("split").textContent).toBe("true");
    act(() => { screen.getByTestId("set-off").click(); });
    expect(screen.getByTestId("split").textContent).toBe("false");
    const blob = JSON.parse(window.localStorage.getItem("libi:editor-state")!);
    // Empty inner is dropped by the nested-flag setter.
    expect(blob.overlaySizeSplitPieces.p1).toBeUndefined();
  });
});
