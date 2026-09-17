// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within, createEvent } from "@testing-library/react";

// The dialog is bound to Sentry through exactly one seam — `captureFeedback` —
// plus the same `trackEvent`/`toast` seams the old widget used. All three are
// mocked so the component's contract with each is asserted directly, the same
// approach __tests__/unit/components/settings-feedback-section.test.tsx used
// for the widget it replaces.
const captureFeedback = vi.fn();
const trackEvent = vi.fn();
const toastSuccess = vi.fn();

vi.mock("@sentry/nextjs", () => ({
  captureFeedback: (...args: unknown[]) => captureFeedback(...args),
}));
vi.mock("@/lib/analytics/client", () => ({
  trackEvent: (...args: unknown[]) => trackEvent(...args),
}));
vi.mock("sonner", () => ({ toast: { success: (...args: unknown[]) => toastSuccess(...args) } }));

const { FeedbackDialog } = await import("@/components/settings/feedback-dialog");

// jsdom's File/Blob implement only `slice`/`size`/`type` — no `arrayBuffer()`
// (verified against the installed jsdom 27; a real browser and Electron's
// Chromium both have it). The component itself must keep using
// `file.arrayBuffer()`, never `FileReader` — that's a hard call in the
// plan — so the gap is patched here, in the TEST ONLY, via `FileReader`,
// which jsdom does implement fully enough to round-trip real bytes.
if (typeof File.prototype.arrayBuffer !== "function") {
  File.prototype.arrayBuffer = function (this: File): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

/**
 * A File whose reported `.size` is set directly rather than by allocating
 * that many bytes of real content — the per-file/total caps only ever read
 * `.size`, and a real 20 MB+ Blob per test would make the suite slow for no
 * behavioural gain. Content stays tiny and real so a KEPT file's
 * `arrayBuffer()` (exercised on submit) still resolves to actual bytes.
 */
function makeFile(name: string, size: number, type = "image/png"): File {
  const file = new File([new Uint8Array(4)], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function getFileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error("file input not found");
  return input as HTMLInputElement;
}

function pick(files: File[]) {
  fireEvent.change(getFileInput(), { target: { files } });
}

function typeMessage(text: string) {
  fireEvent.change(screen.getByLabelText(/what happened/i), { target: { value: text } });
}

function attachedRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll("li"));
}

function getPanel(): HTMLElement {
  return screen.getByTestId("feedback-dialog-panel");
}

/** A dragover carrying real OS files — the type that arms the drop overlay. */
function dragOverPanel() {
  fireEvent.dragOver(getPanel(), { dataTransfer: { types: ["Files"], dropEffect: "" } });
}

function dropFiles(files: File[]) {
  fireEvent.drop(getPanel(), { dataTransfer: { files, types: ["Files"] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  captureFeedback.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("FeedbackDialog", () => {
  it("rejects a file over the per-file cap, naming it, and does not attach it", () => {
    render(<FeedbackDialog open onOpenChange={vi.fn()} />);

    pick([makeFile("huge.png", 20 * 1024 * 1024)]);

    expect(screen.getByText(/"huge\.png" is over the 19\.9 MB per-file limit/)).toBeInTheDocument();
    expect(attachedRows()).toHaveLength(0);
  });

  it("rejects a pick that would push the running total over the total cap", () => {
    render(<FeedbackDialog open onOpenChange={vi.fn()} />);

    // Each file is well under the 19.9 MB per-file cap on its own; only the
    // 50 MB TOTAL is the limit under test here.
    pick([makeFile("a.png", 18 * 1024 * 1024)]);
    expect(attachedRows()).toHaveLength(1);

    pick([makeFile("b.png", 18 * 1024 * 1024)]); // 18 + 18 = 36 MB, still fine
    expect(attachedRows()).toHaveLength(2);

    pick([makeFile("c.png", 18 * 1024 * 1024)]); // 36 + 18 = 54 > 50 MB total cap

    expect(
      screen.getByText(/"c\.png" would push the total past 50\.0 MB/),
    ).toBeInTheDocument();
    // Still just the two files from before — c.png was not attached.
    expect(attachedRows()).toHaveLength(2);
    expect(attachedRows().map((row) => row.textContent)).not.toEqual(
      expect.arrayContaining([expect.stringContaining("c.png")]),
    );
  });

  it("rejects more than the max number of files", () => {
    render(<FeedbackDialog open onOpenChange={vi.fn()} />);

    const sixFiles = Array.from({ length: 6 }, (_, i) => makeFile(`img${i}.png`, 1024));
    pick(sixFiles);

    expect(attachedRows()).toHaveLength(5);
    expect(screen.getByText(/Only 5 images can be attached at once/)).toHaveTextContent(
      "img5.png",
    );
  });

  it("a removed file is not sent", async () => {
    render(<FeedbackDialog open onOpenChange={vi.fn()} />);

    pick([makeFile("keep.png", 1024), makeFile("drop.png", 2048)]);
    expect(attachedRows()).toHaveLength(2);

    const dropRow = screen.getByText(/drop\.png/).closest("li");
    if (!dropRow) throw new Error("drop.png row not found");
    fireEvent.click(within(dropRow).getByRole("button", { name: /remove drop\.png/i }));

    expect(attachedRows()).toHaveLength(1);

    typeMessage("a bug report");
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    await waitFor(() => expect(captureFeedback).toHaveBeenCalledTimes(1));
    const [, hint] = captureFeedback.mock.calls[0] as [unknown, { attachments: { filename: string }[] }];
    expect(hint.attachments).toHaveLength(1);
    expect(hint.attachments[0].filename).toBe("keep.png");
  });

  it("captureFeedback receives the message and one attachment per kept file", async () => {
    render(<FeedbackDialog open onOpenChange={vi.fn()} />);

    pick([makeFile("one.png", 1024), makeFile("two.png", 2048)]);
    typeMessage("the export button does nothing");
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    await waitFor(() => expect(captureFeedback).toHaveBeenCalledTimes(1));
    const [params, hint] = captureFeedback.mock.calls[0] as [
      { message: string },
      { attachments: { filename: string; data: Uint8Array; contentType?: string }[] },
    ];
    expect(params.message).toBe("the export button does nothing");
    expect(hint.attachments).toHaveLength(2);
    expect(hint.attachments.map((a) => a.filename)).toEqual(["one.png", "two.png"]);
    expect(hint.attachments[0].data).toBeInstanceOf(Uint8Array);
  });

  it("email omitted when blank", async () => {
    render(<FeedbackDialog open onOpenChange={vi.fn()} />);

    typeMessage("small thing");
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    await waitFor(() => expect(captureFeedback).toHaveBeenCalledTimes(1));
    const [params] = captureFeedback.mock.calls[0] as [{ email?: string }];
    expect(params.email).toBeUndefined();
  });

  it("a send failure keeps the dialog open and the message intact", async () => {
    captureFeedback.mockRejectedValueOnce(new Error("network down"));
    const onOpenChange = vi.fn();
    const onSubmitted = vi.fn();
    render(<FeedbackDialog open onOpenChange={onOpenChange} onSubmitted={onSubmitted} />);

    typeMessage("my careful bug report");
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    await waitFor(() => expect(captureFeedback).toHaveBeenCalledTimes(1));

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/what happened/i)).toHaveValue("my careful bug report");
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
    // A failed send is not a "sent" for the purposes of the trigger's success
    // tick — see FeedbackSection, which lights up only off this callback.
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it("calls onSubmitted once a send actually succeeds", async () => {
    const onSubmitted = vi.fn();
    render(<FeedbackDialog open onOpenChange={vi.fn()} onSubmitted={onSubmitted} />);

    typeMessage("the export button does nothing");
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    await waitFor(() => expect(captureFeedback).toHaveBeenCalledTimes(1));
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it("never calls onSubmitted when the dialog is merely cancelled", () => {
    const onSubmitted = vi.fn();
    render(<FeedbackDialog open onOpenChange={vi.fn()} onSubmitted={onSubmitted} />);

    typeMessage("a draft I decided not to send");
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it("clears a cancelled draft so it never reappears on the next open", async () => {
    // Cancel / Escape / backdrop all route through one reset. Without it the
    // dialog reopens holding a message the user deliberately abandoned — and,
    // worse, a stale error from a failed send that no longer applies.
    const onOpenChange = vi.fn();
    const { rerender } = render(<FeedbackDialog open onOpenChange={onOpenChange} />);

    typeMessage("a draft I decided not to send");
    pick([makeFile("shot.png", 1024)]);
    expect(attachedRows()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    // Reopen the same mounted dialog, as the section does.
    rerender(<FeedbackDialog open={false} onOpenChange={onOpenChange} />);
    rerender(<FeedbackDialog open onOpenChange={onOpenChange} />);

    expect(screen.getByLabelText(/what happened/i)).toHaveValue("");
    expect(attachedRows()).toHaveLength(0);
  });

  it("analytics params stay booleans and carry neither the message nor the address", async () => {
    render(<FeedbackDialog open onOpenChange={vi.fn()} />);

    pick([makeFile("shot.png", 1024)]);
    typeMessage("the export button breaks on save");
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "jane@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    await waitFor(() => expect(trackEvent).toHaveBeenCalledTimes(1));
    expect(trackEvent).toHaveBeenCalledWith("feedback_submitted", {
      with_email: true,
      with_screenshot: true,
    });
    const serialized = JSON.stringify(trackEvent.mock.calls[0][1]);
    expect(serialized).not.toContain("jane@example.com");
    expect(serialized).not.toContain("export button breaks");
  });
});

describe("FeedbackDialog drag-and-drop", () => {
  it("shows the drop overlay while a file drag is over the panel, and clears it when the pointer names a spot outside", () => {
    render(<FeedbackDialog open onOpenChange={vi.fn()} />);

    expect(screen.queryByTestId("feedback-dialog-drag-overlay")).not.toBeInTheDocument();
    dragOverPanel();
    expect(screen.getByTestId("feedback-dialog-drag-overlay")).toBeInTheDocument();

    const ev = createEvent.dragLeave(getPanel());
    Object.defineProperty(ev, "relatedTarget", { value: document.body });
    fireEvent(getPanel(), ev);

    expect(screen.queryByTestId("feedback-dialog-drag-overlay")).not.toBeInTheDocument();
  });

  // REGRESSION GUARD. This repo already shipped this exact bug once, in
  // components/preview/timeline.tsx: Chromium fires `dragleave` with
  // `relatedTarget === null` while the pointer is still mid-drag INSIDE the
  // panel — not only when it truly leaves the window. A naive
  // `if (!e.relatedTarget) setDragActive(false)` therefore flickers the ring
  // off on an ordinary drag. Only a dragleave naming an element OUTSIDE the
  // panel (covered above) may clear the state.
  it("does NOT clear the drag state on a dragleave whose relatedTarget is null", () => {
    render(<FeedbackDialog open onOpenChange={vi.fn()} />);

    dragOverPanel();
    expect(screen.getByTestId("feedback-dialog-drag-overlay")).toBeInTheDocument();

    const ev = createEvent.dragLeave(getPanel());
    Object.defineProperty(ev, "relatedTarget", { value: null });
    fireEvent(getPanel(), ev);

    expect(screen.getByTestId("feedback-dialog-drag-overlay")).toBeInTheDocument();
  });

  it("attaches image files dropped anywhere on the dialog panel, and clears the overlay", () => {
    render(<FeedbackDialog open onOpenChange={vi.fn()} />);

    dragOverPanel();
    dropFiles([makeFile("screenshot.png", 1024)]);

    expect(attachedRows()).toHaveLength(1);
    expect(screen.queryByTestId("feedback-dialog-drag-overlay")).not.toBeInTheDocument();
  });

  it("validates a drop with the same per-file cap the picker uses, naming the same rejection", () => {
    render(<FeedbackDialog open onOpenChange={vi.fn()} />);

    // Same message asserted in "rejects a file over the per-file cap" above —
    // proof the drop path calls handleFilesPicked rather than re-implementing
    // the caps.
    dropFiles([makeFile("huge.png", 20 * 1024 * 1024)]);

    expect(screen.getByText(/"huge\.png" is over the 19\.9 MB per-file limit/)).toBeInTheDocument();
    expect(attachedRows()).toHaveLength(0);
  });

  it("reports inline, and attaches nothing, when a drop contains only non-image files", () => {
    render(<FeedbackDialog open onOpenChange={vi.fn()} />);

    dropFiles([makeFile("notes.txt", 1024, "text/plain")]);

    expect(screen.getByText(/Only image files can be attached/)).toBeInTheDocument();
    expect(attachedRows()).toHaveLength(0);
  });

  it("silently ignores non-image files mixed into a drop that also has images", () => {
    render(<FeedbackDialog open onOpenChange={vi.fn()} />);

    dropFiles([makeFile("notes.txt", 1024, "text/plain"), makeFile("shot.png", 1024)]);

    expect(attachedRows()).toHaveLength(1);
    expect(attachedRows()[0]).toHaveTextContent("shot.png");
    expect(screen.queryByText(/Only image files can be attached/)).not.toBeInTheDocument();
  });
});
