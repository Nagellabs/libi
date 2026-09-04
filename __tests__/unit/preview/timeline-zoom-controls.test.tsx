// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import TimelineZoomControls from "@/components/preview/timeline-zoom-controls";
import { maxPxPerSec } from "@/lib/preview/timeline-zoom";

const FIT = 40;
const MAX = maxPxPerSec(30); // 1200 — a representative frame-derived ceiling

describe("TimelineZoomControls", () => {
  it("reads ×1 and parks the slider at 0 while at Fit", () => {
    render(<TimelineZoomControls pxPerSec={FIT} fitPx={FIT} maxPx={MAX} onZoom={() => {}} onFit={() => {}} />);
    expect(screen.getByTestId("zoom-readout")).toHaveTextContent("×1");
    expect((screen.getByTestId("zoom-slider") as HTMLInputElement).value).toBe("0");
  });

  it("puts the slider at its maximum when zoomed all the way in", () => {
    render(
      <TimelineZoomControls
        pxPerSec={MAX}
        fitPx={FIT}
        maxPx={MAX}
        onZoom={() => {}}
        onFit={() => {}}
      />,
    );
    expect((screen.getByTestId("zoom-slider") as HTMLInputElement).value).toBe("1");
  });

  it("reports a zoom above fit when the slider is dragged right", () => {
    const onZoom = vi.fn();
    render(<TimelineZoomControls pxPerSec={FIT} fitPx={FIT} maxPx={MAX} onZoom={onZoom} onFit={() => {}} />);
    fireEvent.change(screen.getByTestId("zoom-slider"), { target: { value: "0.5" } });
    expect(onZoom).toHaveBeenCalledTimes(1);
    expect(onZoom.mock.calls[0][0]).toBeCloseTo(Math.sqrt(FIT * MAX), 3);
  });

  it("steps the zoom in and out with the buttons", () => {
    const onZoom = vi.fn();
    render(<TimelineZoomControls pxPerSec={100} fitPx={FIT} maxPx={MAX} onZoom={onZoom} onFit={() => {}} />);
    fireEvent.click(screen.getByTestId("zoom-in"));
    expect(onZoom).toHaveBeenLastCalledWith(120);
    fireEvent.click(screen.getByTestId("zoom-out"));
    expect(onZoom.mock.calls[1][0]).toBeCloseTo(100 / 1.2, 6);
  });

  it("calls onFit from the fit button", () => {
    const onFit = vi.fn();
    render(<TimelineZoomControls pxPerSec={400} fitPx={FIT} maxPx={MAX} onZoom={() => {}} onFit={onFit} />);
    fireEvent.click(screen.getByTestId("zoom-fit"));
    expect(onFit).toHaveBeenCalledTimes(1);
  });

  it("labels the slider and mentions the Shift+Z fit shortcut on the fit button", () => {
    render(<TimelineZoomControls pxPerSec={FIT} fitPx={FIT} maxPx={MAX} onZoom={() => {}} onFit={() => {}} />);
    expect(screen.getByTestId("zoom-slider")).toHaveAttribute("aria-label", "Timeline zoom");
    expect(screen.getByTestId("zoom-fit")).toHaveAttribute("title", "Fit to viewport (Shift+Z)");
  });
});
