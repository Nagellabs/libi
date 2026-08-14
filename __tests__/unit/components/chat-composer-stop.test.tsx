// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
});

function renderComposer(props: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
  const baseProps = {
    inputValue: "",
    onInputChange: vi.fn(),
    pendingFiles: [],
    onFilesSelected: vi.fn(),
    onRemoveFile: vi.fn(),
    onClearFiles: vi.fn(),
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    disabled: false,
    canSend: false,
    isStreaming: false,
    sessionId: null,
    ...props,
  };
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <EditorStateProvider>
        <ChatComposer {...baseProps} />
      </EditorStateProvider>
    </QueryClientProvider>
  );
}

describe("ChatComposer Stop button", () => {
  it("shows Send arrow when idle", () => {
    renderComposer();
    expect(screen.getByLabelText(/send message/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^stop$/i)).not.toBeInTheDocument();
  });

  it("shows Stop square when streaming", () => {
    renderComposer({ isStreaming: true });
    expect(screen.getByLabelText(/^stop$/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/send message/i)).not.toBeInTheDocument();
  });

  it("calls onCancel when Stop clicked", () => {
    const onCancel = vi.fn();
    renderComposer({ isStreaming: true, onCancel });
    fireEvent.click(screen.getByLabelText(/^stop$/i));
    expect(onCancel).toHaveBeenCalled();
  });

  it("textarea stays enabled while streaming so user can steer", () => {
    renderComposer({ isStreaming: true });
    const textarea = screen.getByPlaceholderText(/describe a scene/i) as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
  });
});
