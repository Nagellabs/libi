// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

const handleDrop = vi.fn();
vi.mock("@/hooks/terminal/use-terminal-file-drop", () => ({
  useTerminalFileDrop: (opts: unknown) => {
    lastOptions = opts;
    return { handleDrop, isUploading: mockIsUploading };
  },
}));
let lastOptions: unknown;
let mockIsUploading = false;

vi.mock("@/lib/queries/terminals", () => ({
  useTerminalSessions: () => ({ data: sessions, isLoading: false, isFetching: false }),
  useCreateTerminal: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
// Shape this from the real return type of `useTerminalSessions` in
// `lib/queries/terminals.ts` — read it rather than guessing; the panel reads
// more than `id` off a session and a short fixture will fail in a way that
// looks like a drop bug.
let sessions: {
  id: string;
  title: string;
  cliId: string;
  createdAt: number;
  status: "running" | "exited";
}[] = [];

vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    activeTerminalId,
    setActiveTerminalId: vi.fn(),
    terminalCliId: "shell",
    onboardingDemoOffer: false,
    setOnboardingDemoOffer: vi.fn(),
  }),
}));
let activeTerminalId: string | null = null;

vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));
import { toast } from "sonner";

// TerminalView is a `next/dynamic` import of xterm, which touches DOM/WebGL at
// module scope. Rendering it under jsdom is both slow and irrelevant here —
// this test is about the panel's drop wiring, not the terminal itself.
vi.mock("@/components/terminal/terminal-view", () => ({
  default: () => <div data-testid="terminal-view-stub" />,
}));

import TerminalPanel from "@/components/terminal/terminal-panel";

// jsdom does not implement the DataTransfer constructor, so — matching the
// pattern already used in timeline-overlay-row-drop.test.tsx — we hand the
// handler a plain object shaped like the bit of DataTransfer it reads.
// `types` defaults to mirroring `files` (a real file drag carries a "Files"
// entry); pass it explicitly to simulate an in-app drag — e.g. the Resources
// panel's own asset drag, which carries `application/libi-file-id` /
// `x-libi-asset` but NO `dataTransfer.files`.
function fakeDataTransfer(files: File[], types?: string[]) {
  return {
    files: files as unknown as FileList,
    types: types ?? (files.length > 0 ? ["Files"] : []),
  };
}

function dropOn(el: Element, files: File[], types?: string[]) {
  const ev = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: fakeDataTransfer(files, types) });
  el.dispatchEvent(ev);
  return ev;
}

const png = () => new File([new Uint8Array([1])], "shot.png", { type: "image/png" });

beforeEach(() => {
  vi.clearAllMocks();
  sessions = [];
  activeTerminalId = null;
  mockIsUploading = false;
});

describe("TerminalPanel file drop", () => {
  it("hands dropped files to the hook and reports a live terminal", () => {
    sessions = [
      { id: "t1", title: "Shell", cliId: "shell", createdAt: 0, status: "running" },
    ];
    activeTerminalId = "t1";
    const { container } = render(<TerminalPanel />);

    dropOn(container.firstElementChild!, [png()]);

    expect(handleDrop).toHaveBeenCalledTimes(1);
    expect(handleDrop.mock.calls[0][0]).toHaveLength(1);
    expect(lastOptions).toMatchObject({ hasLiveTerminal: true });
  });

  it("still intercepts the drop with NO terminal open", () => {
    // preventDefault is the point: without it Electron navigates the whole
    // window to the dropped file, losing the session. The hook decides what to
    // say; the panel's job is to stop the browser.
    const { container } = render(<TerminalPanel />);

    const ev = dropOn(container.firstElementChild!, [png()]);

    expect(ev.defaultPrevented).toBe(true);
    expect(handleDrop).toHaveBeenCalledTimes(1);
    expect(lastOptions).toMatchObject({ hasLiveTerminal: false });
  });

  it("prevents the default on dragover too", () => {
    // A drop event only fires at all if dragover was cancelled.
    const { container } = render(<TerminalPanel />);
    const ev = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: fakeDataTransfer([]) });
    container.firstElementChild!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("toasts instead of silently doing nothing when a non-file drag lands with no files", () => {
    // The panel advertises as a drop target for ANY drag (dragover always
    // cancels), including the Resources panel's own in-app asset drag,
    // which carries `application/libi-file-id` but no `dataTransfer.files`.
    // Before this fix `handleDrop([])` was called and returned silently.
    sessions = [
      { id: "t1", title: "Shell", cliId: "shell", createdAt: 0, status: "running" },
    ];
    activeTerminalId = "t1";
    const { container } = render(<TerminalPanel />);

    dropOn(container.firstElementChild!, [], ["application/libi-file-id", "x-libi-asset"]);

    expect(handleDrop).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalled();
  });

  it("stays silent on a genuinely empty drag", () => {
    sessions = [
      { id: "t1", title: "Shell", cliId: "shell", createdAt: 0, status: "running" },
    ];
    activeTerminalId = "t1";
    const { container } = render(<TerminalPanel />);

    dropOn(container.firstElementChild!, [], []);

    expect(handleDrop).toHaveBeenCalledTimes(1);
    expect(handleDrop.mock.calls[0][0]).toHaveLength(0);
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("shows an uploading indicator while the hook reports isUploading", () => {
    sessions = [
      { id: "t1", title: "Shell", cliId: "shell", createdAt: 0, status: "running" },
    ];
    activeTerminalId = "t1";
    mockIsUploading = true;
    const { queryByTestId, rerender } = render(<TerminalPanel />);

    expect(queryByTestId("terminal-drop-uploading")).not.toBeNull();

    mockIsUploading = false;
    rerender(<TerminalPanel />);
    expect(queryByTestId("terminal-drop-uploading")).toBeNull();
  });
});
