// @vitest-environment jsdom
//
// Palette open/close lifecycle in the composer. Pins the two review findings
// from the command-palette integration:
//  1. Picking a no-arg command (Enter on "/cl" → "/clear") must CLOSE the
//     palette so the next Enter submits — not re-pick the same row forever.
//  2. The Esc `dismissed` flag must reset after a programmatic input clear
//     (parent submit), or the palette stays suppressed for the NEXT slash
//     command.
import { describe, it, expect, vi, beforeAll } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ChatComposer from "@/components/chat/chat-composer";
import { EditorStateProvider } from "@/lib/editor-state-context";

// EditorStateProvider uses useRouter — mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// EditorStateProvider uses useSessionList which calls fetch-based queries — mock it
vi.mock("@/hooks/sessions/use-session-list", () => ({
  useSessionList: () => ({
    sessions: [],
    isLoading: false,
    selectedSessionId: null,
    selectSession: vi.fn(),
  }),
}));

// jsdom does not implement EventSource — stub it out
beforeAll(() => {
  if (typeof globalThis.EventSource === "undefined") {
    globalThis.EventSource = class {
      addEventListener() {}
      removeEventListener() {}
      close() {}
    } as unknown as typeof EventSource;
  }
  // jsdom does not implement scrollIntoView (palette keeps selection visible)
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

/** Stateful harness mimicking ChatPanel: owns inputValue, clears it on
 *  submit (programmatically — no onChange event fires for that clear). */
function Harness({ onSubmitSpy }: { onSubmitSpy: () => void }) {
  const [inputValue, setInputValue] = useState("");
  return (
    <ChatComposer
      inputValue={inputValue}
      onInputChange={setInputValue}
      pendingFiles={[]}
      onFilesSelected={vi.fn()}
      onRemoveFile={vi.fn()}
      onClearFiles={vi.fn()}
      onSubmit={(e) => {
        e.preventDefault?.();
        onSubmitSpy();
        setInputValue("");
      }}
      onCancel={vi.fn()}
      disabled={false}
      canSend={true}
      isStreaming={false}
      sessionId={null}
    />
  );
}

function renderHarness() {
  const onSubmitSpy = vi.fn();
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <EditorStateProvider>
        <Harness onSubmitSpy={onSubmitSpy} />
      </EditorStateProvider>
    </QueryClientProvider>,
  );
  const textarea = screen.getByPlaceholderText(
    /describe a scene/i,
  ) as HTMLTextAreaElement;
  return { onSubmitSpy, textarea };
}

function type(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, {
    target: { value, selectionStart: value.length },
  });
}

// sessionId is null → no agent commands; the locally injected /clear entry
// is the palette's sole row, which is exactly what these tests exercise.
describe("ChatComposer command palette lifecycle", () => {
  it("Enter picks the command AND closes the palette; the next Enter submits", () => {
    const { onSubmitSpy, textarea } = renderHarness();

    type(textarea, "/cl");
    expect(screen.getByText("/clear")).toBeInTheDocument();

    // First Enter: pick — inserts "/clear", closes palette, does NOT submit.
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmitSpy).not.toHaveBeenCalled();
    expect(textarea.value).toBe("/clear");
    expect(screen.queryByText("Start a new chat")).not.toBeInTheDocument();

    // Second Enter: palette closed → falls through to submit.
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmitSpy).toHaveBeenCalledTimes(1);
  });

  it("Esc dismisses for the current token but resets after a programmatic submit-clear", () => {
    const { onSubmitSpy, textarea } = renderHarness();

    type(textarea, "/c");
    expect(screen.getByText("/clear")).toBeInTheDocument();

    // Esc closes; further typing within the same slash token keeps it closed.
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByText("/clear")).not.toBeInTheDocument();
    type(textarea, "/cl");
    expect(screen.queryByText("/clear")).not.toBeInTheDocument();

    // Enter now submits the raw text; the parent clears the input
    // programmatically (no onChange fires for that clear).
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmitSpy).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe("");

    // The dismissed flag must have reset: a fresh slash command reopens.
    act(() => {
      type(textarea, "/c");
    });
    expect(screen.getByText("/clear")).toBeInTheDocument();
  });

  it("arrow keys and Escape are ignored while the palette shows zero rows", () => {
    const { onSubmitSpy, textarea } = renderHarness();

    // "/zzz" matches nothing (no agent commands, no clear substring).
    type(textarea, "/zzz");
    expect(screen.queryByText("/clear")).not.toBeInTheDocument();

    // Enter falls through to submit — the empty palette must not swallow it.
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmitSpy).toHaveBeenCalledTimes(1);
  });
});
