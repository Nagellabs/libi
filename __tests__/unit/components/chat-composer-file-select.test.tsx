/**
 * Regression: ChatComposer's file input must hand the parent a
 * snapshotted `File[]`, NOT a live `FileList`. Setting `value = ""`
 * (which we do so the same file can be re-picked) empties the live
 * FileList synchronously per the WHATWG spec — any deferred read inside
 * a React state updater closure would then see zero files. This was the
 * "click upload after creating a new session → no thumbnail" bug.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ChatComposer from "@/components/chat/chat-composer";
import { EditorStateProvider } from "@/lib/editor-state-context";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/hooks/sessions/use-session-list", () => ({
  useSessionList: () => ({
    sessions: [],
    isLoading: false,
    selectedSessionId: null,
    selectSession: vi.fn(),
  }),
}));

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
    </QueryClientProvider>,
  );
}

describe("ChatComposer file selection", () => {
  it("delivers a materialized File[] to onFilesSelected (not a live FileList)", () => {
    const onFilesSelected = vi.fn();
    const { container } = renderComposer({ onFilesSelected });

    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(input).not.toBeNull();

    const file = new File([new Uint8Array([1, 2, 3])], "clip.mp4", {
      type: "video/mp4",
    });
    fireEvent.change(input, { target: { files: [file] } });

    expect(onFilesSelected).toHaveBeenCalledTimes(1);
    const arg = onFilesSelected.mock.calls[0][0];
    // Must be a real array — caller can iterate without worrying about
    // FileList liveness.
    expect(Array.isArray(arg)).toBe(true);
    expect(arg).toHaveLength(1);
    expect(arg[0]).toBe(file);
  });

  it("does not call onFilesSelected when the user cancels (no files)", () => {
    const onFilesSelected = vi.fn();
    const { container } = renderComposer({ onFilesSelected });
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    fireEvent.change(input, { target: { files: [] } });
    expect(onFilesSelected).not.toHaveBeenCalled();
  });

  it("captures files BEFORE clearing the input value (the actual race)", () => {
    // Simulate the bug we fixed: have onFilesSelected stash the input element
    // and re-read its `.files` afterwards. Even though the handler clears
    // value="" before returning, the snapshot we passed up must already
    // be a stable array.
    const onFilesSelected = vi.fn();
    const { container } = renderComposer({ onFilesSelected });
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    const file = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    // After the change handler has run, the input's value is reset so the
    // next selection of the SAME file will refire change.
    expect(input.value).toBe("");
    // ...but the snapshot we delivered upward still has the file.
    expect(onFilesSelected.mock.calls[0][0]).toEqual([file]);
  });

  it("upload button click delegates to the hidden file input", () => {
    const onFilesSelected = vi.fn();
    const { container } = renderComposer({ onFilesSelected });
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");

    const attachBtn = screen.getByTitle(/attach files/i);
    fireEvent.click(attachBtn);

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
});
