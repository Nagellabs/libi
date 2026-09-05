// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const openWith = vi.fn();
const dispatchSend = vi.fn(async () => true);
const dispatchCopy = vi.fn(async () => true);
vi.mock("@/hooks/agent/use-dispatch-to-agent", () => ({
  useDispatchToAgent: () => ({
    open: false, setOpen: vi.fn(), prompt: "", send: dispatchSend, copy: dispatchCopy,
    sending: false, openWith,
  }),
}));

// Capture the props AspectRatioControl actually passes to the dialog, so
// tests can invoke the wrapped send/copy handlers exactly as a click would —
// the whole point of this fix is that the analytics event lives in those
// handlers, not in openWith.
let lastDialogProps: { send: () => void; copy: () => void } | null = null;
vi.mock("@/components/agent/dispatch-to-agent-dialog", () => ({
  DispatchToAgentDialog: (props: { send: () => void; copy: () => void }) => {
    lastDialogProps = props;
    return null;
  },
}));

const trackEvent = vi.fn();
vi.mock("@/lib/analytics/client", () => ({
  trackEvent: (n: string, p?: Record<string, unknown>) => trackEvent(n, p),
}));

const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
vi.stubGlobal("fetch", fetchMock);

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

import { AspectRatioControl } from "@/components/preview/aspect-ratio-control";

const base = { pieceId: "p1", pieceName: "Demo", width: 1920, height: 1080, overlayCount: 0 };

beforeEach(() => {
  openWith.mockClear();
  dispatchSend.mockClear();
  dispatchSend.mockImplementation(async () => true);
  dispatchCopy.mockClear();
  dispatchCopy.mockImplementation(async () => true);
  lastDialogProps = null;
  trackEvent.mockClear();
  toastError.mockClear();
  toastSuccess.mockClear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({}) }));
});

describe("AspectRatioControl", () => {
  it("marks landscape active for a 16:9 piece", () => {
    render(<AspectRatioControl {...base} />);
    expect(screen.getByTestId("orientation-landscape").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("orientation-portrait").getAttribute("aria-pressed")).toBe("false");
  });

  it("marks portrait active for a 9:16 piece", () => {
    render(<AspectRatioControl {...base} width={1080} height={1920} />);
    expect(screen.getByTestId("orientation-portrait").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("orientation-landscape").getAttribute("aria-pressed")).toBe("false");
  });

  it("marks NEITHER active for a square piece", () => {
    // The third orientation is why the label exists — without it a 1:1 piece
    // reads as "nothing selected", which looks broken.
    render(<AspectRatioControl {...base} width={1080} height={1080} />);
    expect(screen.getByTestId("orientation-portrait").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("orientation-landscape").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("aspect-ratio-label").textContent).toBe("1:1");
  });

  it("labels a catalog ratio by its id", () => {
    render(<AspectRatioControl {...base} />);
    expect(screen.getByTestId("aspect-ratio-label").textContent).toBe("16:9");
  });

  it("labels a custom ratio with its pixels rather than the nearest entry", () => {
    render(<AspectRatioControl {...base} width={1000} height={1400} />);
    expect(screen.getByTestId("aspect-ratio-label").textContent).toBe("1000x1400");
  });

  it("writes directly and reports mode=direct for an empty piece", async () => {
    render(<AspectRatioControl {...base} />);
    fireEvent.click(screen.getByTestId("orientation-portrait"));
    fireEvent.click(screen.getByTestId("ratio-card-9:16"));
    fireEvent.click(screen.getByTestId("ratio-confirm"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/pieces/p1/composition/dimensions",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    expect(openWith).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith("aspect_ratio_changed", {
      ratio: "9:16", mode: "direct",
    });
  });

  it("dispatches to the agent and never writes directly when the piece has overlays", async () => {
    render(<AspectRatioControl {...base} overlayCount={3} />);
    fireEvent.click(screen.getByTestId("orientation-portrait"));
    fireEvent.click(screen.getByTestId("ratio-card-9:16"));
    fireEvent.click(screen.getByTestId("ratio-confirm"));

    await waitFor(() => expect(openWith).toHaveBeenCalledTimes(1));
    // The critical half: a direct write here would resize the canvas and
    // strand every overlay outside it.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openWith.mock.calls[0][0]).toContain("libi.update_composition_dimensions");
    // Opening the dispatch dialog must NOT record a change by itself —
    // cancelling it still shouldn't count. See the tests below for when the
    // event actually fires.
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("does not track a dispatched change on cancel — only on an actual send or copy", async () => {
    render(<AspectRatioControl {...base} overlayCount={3} />);
    fireEvent.click(screen.getByTestId("orientation-portrait"));
    fireEvent.click(screen.getByTestId("ratio-card-9:16"));
    fireEvent.click(screen.getByTestId("ratio-confirm"));

    await waitFor(() => expect(openWith).toHaveBeenCalledTimes(1));
    // Simulate the dialog being dismissed without send/copy ever firing.
    expect(dispatchSend).not.toHaveBeenCalled();
    expect(dispatchCopy).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("tracks the dispatched change once the prompt is actually sent", async () => {
    render(<AspectRatioControl {...base} overlayCount={3} />);
    fireEvent.click(screen.getByTestId("orientation-portrait"));
    fireEvent.click(screen.getByTestId("ratio-card-9:16"));
    fireEvent.click(screen.getByTestId("ratio-confirm"));
    await waitFor(() => expect(openWith).toHaveBeenCalledTimes(1));

    await lastDialogProps!.send();

    expect(dispatchSend).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith("aspect_ratio_changed", {
      ratio: "9:16", mode: "dispatched",
    });
  });

  it("tracks the dispatched change once the prompt is copied", async () => {
    render(<AspectRatioControl {...base} overlayCount={3} />);
    fireEvent.click(screen.getByTestId("orientation-portrait"));
    fireEvent.click(screen.getByTestId("ratio-card-9:16"));
    fireEvent.click(screen.getByTestId("ratio-confirm"));
    await waitFor(() => expect(openWith).toHaveBeenCalledTimes(1));

    await lastDialogProps!.copy();

    expect(dispatchCopy).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith("aspect_ratio_changed", {
      ratio: "9:16", mode: "dispatched",
    });
  });

  it("does not track when the send fails (BYO-CLI or a request error)", async () => {
    dispatchSend.mockImplementation(async () => false);
    render(<AspectRatioControl {...base} overlayCount={3} />);
    fireEvent.click(screen.getByTestId("orientation-portrait"));
    fireEvent.click(screen.getByTestId("ratio-card-9:16"));
    fireEvent.click(screen.getByTestId("ratio-confirm"));
    await waitFor(() => expect(openWith).toHaveBeenCalledTimes(1));

    await lastDialogProps!.send();

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("shows an error toast and skips trackEvent when the PATCH responds non-OK", async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    render(<AspectRatioControl {...base} />);
    fireEvent.click(screen.getByTestId("orientation-portrait"));
    fireEvent.click(screen.getByTestId("ratio-card-9:16"));
    fireEvent.click(screen.getByTestId("ratio-confirm"));

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(trackEvent).not.toHaveBeenCalled();
    // The dialog stays open on failure so the user can retry (throws if gone).
    expect(screen.getByTestId("ratio-confirm")).toBeTruthy();
  });

  it("shows an error toast and skips trackEvent when the PATCH fetch rejects", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("network down");
    });
    render(<AspectRatioControl {...base} />);
    fireEvent.click(screen.getByTestId("orientation-portrait"));
    fireEvent.click(screen.getByTestId("ratio-card-9:16"));
    fireEvent.click(screen.getByTestId("ratio-confirm"));

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("gives both toggle buttons a pointer affordance", () => {
    render(<AspectRatioControl {...base} />);
    expect(screen.getByTestId("orientation-portrait").className).toContain("cursor-pointer");
    expect(screen.getByTestId("orientation-landscape").className).toContain("cursor-pointer");
  });
});
