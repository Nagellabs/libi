// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

// The section itself is now just a trigger + a controlled open flag (plus,
// since the success-tick feature, a `sent` flag it flips off `onSubmitted`) —
// the actual feedback UI, and the Sentry/`trackEvent`/toast seams it drives,
// live in FeedbackDialog and are covered by
// __tests__/unit/components/settings-feedback-dialog.test.tsx. Stubbed here so
// these tests stay about the SECTION's own contract: the gate on
// SENTRY_ENABLED, the approved copy, wiring the button to open the dialog, and
// reacting to `onSubmitted`/`onOpenChange` exactly as the real dialog calls
// them (verified over there).
type FeedbackDialogStubProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted?: () => void;
};
const dialogProps = vi.fn();
vi.mock("@/components/settings/feedback-dialog", () => ({
  FeedbackDialog: (props: FeedbackDialogStubProps) => {
    dialogProps(props);
    return props.open ? <div data-testid="feedback-dialog-stub" /> : null;
  },
}));

/** The props the section most recently passed down to <FeedbackDialog>. */
function lastDialogProps(): FeedbackDialogStubProps {
  const calls = dialogProps.mock.calls;
  return calls[calls.length - 1][0] as FeedbackDialogStubProps;
}

// lucide-react's own per-icon class (e.g. "lucide-check") is a stable,
// icon-specific DOM hook — no test id needed on the button, which must keep
// exactly one child icon and the unchanged "Send feedback" label.
function hasIcon(name: "check" | "message-square"): boolean {
  return document.querySelector(`.lucide-${name}`) !== null;
}

// SENTRY_ENABLED is a module-load-time const off process.env, so it is mocked
// per-test rather than driven through the environment.
let sentryEnabled = true;
vi.mock("@/lib/sentry/config", () => ({
  get SENTRY_ENABLED() {
    return sentryEnabled;
  },
}));

const { FeedbackSection } = await import("@/components/settings/feedback-section");

beforeEach(() => {
  sentryEnabled = true;
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("FeedbackSection", () => {
  it("renders the approved copy", () => {
    render(<FeedbackSection />);

    expect(screen.getByRole("heading", { name: "Send feedback" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Found a bug, or something that should work differently? Your feedback matters to us — we read every message. Add your email if you'd like a reply.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send feedback" })).toBeInTheDocument();
  });

  it("renders nothing when Sentry cannot send", () => {
    // A contributor clone or the kill switch. A form that silently discards
    // what the user typed is worse than no form at all.
    sentryEnabled = false;

    const { container } = render(<FeedbackSection />);

    expect(container).toBeEmptyDOMElement();
  });

  it("opens the dialog closed by default, and open on button click", () => {
    render(<FeedbackSection />);

    expect(dialogProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: false }),
    );
    expect(screen.queryByTestId("feedback-dialog-stub")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    expect(dialogProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: true }),
    );
    expect(screen.getByTestId("feedback-dialog-stub")).toBeInTheDocument();
  });

  it("starts with the plain MessageSquare icon, not the success tick", () => {
    render(<FeedbackSection />);

    expect(hasIcon("message-square")).toBe(true);
    expect(hasIcon("check")).toBe(false);
  });

  it("shows a success tick in place of the icon once the dialog reports a successful send", () => {
    render(<FeedbackSection />);
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    act(() => lastDialogProps().onSubmitted?.());

    expect(hasIcon("check")).toBe(true);
    expect(hasIcon("message-square")).toBe(false);
    // The label itself never changes — only the icon swaps.
    expect(screen.getByRole("button", { name: "Send feedback" })).toBeInTheDocument();
  });

  it("does not show the tick when the dialog is merely cancelled (onOpenChange(false) without onSubmitted)", () => {
    render(<FeedbackSection />);
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    // This is exactly what Cancel, Escape, and a backdrop click all do in the
    // real dialog — none of them call onSubmitted. See
    // settings-feedback-dialog.test.tsx for the dialog-side proof that a
    // cancel never fires onSubmitted.
    act(() => lastDialogProps().onOpenChange(false));

    expect(hasIcon("check")).toBe(false);
    expect(hasIcon("message-square")).toBe(true);
  });

  it("does not show the tick after a failed send (the dialog never calls onSubmitted or closes)", () => {
    render(<FeedbackSection />);
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    // A failed send leaves the dialog open and never calls onSubmitted — see
    // settings-feedback-dialog.test.tsx's "a send failure keeps the dialog
    // open" test, which asserts onSubmitted directly. Nothing more happens
    // here at the section boundary, which is exactly the point: silence.
    expect(hasIcon("check")).toBe(false);
    expect(hasIcon("message-square")).toBe(true);
  });

  it("clears a previous tick the moment the button is clicked to open the dialog again", () => {
    render(<FeedbackSection />);
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    act(() => lastDialogProps().onSubmitted?.());
    expect(hasIcon("check")).toBe(true);

    // The dialog closes itself right after calling onSubmitted; simulate
    // that, then the user opening it again.
    act(() => lastDialogProps().onOpenChange(false));
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    expect(hasIcon("check")).toBe(false);
    expect(hasIcon("message-square")).toBe(true);
  });
});
