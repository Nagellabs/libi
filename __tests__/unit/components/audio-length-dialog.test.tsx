// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AudioLengthDialog } from "@/components/preview/audio-length-dialog";

const props = {
  open: true,
  assetName: "Fimm So Good.mp3",
  assetDurationSec: 229,
  pieceDurationSec: 3,
};

describe("AudioLengthDialog", () => {
  it("names the asset and both lengths", () => {
    render(<AudioLengthDialog {...props} onChoose={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/Fimm So Good\.mp3/)).toBeInTheDocument();
    expect(screen.getByText(/3:49/)).toBeInTheDocument();
    expect(screen.getByText(/0:03/)).toBeInTheDocument();
  });

  it("Extend chooses the asset's full length", () => {
    const onChoose = vi.fn();
    render(<AudioLengthDialog {...props} onChoose={onChoose} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /extend/i }));
    expect(onChoose).toHaveBeenCalledWith(229);
  });

  it("Trim chooses the piece's length", () => {
    const onChoose = vi.fn();
    render(<AudioLengthDialog {...props} onChoose={onChoose} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /trim/i }));
    expect(onChoose).toHaveBeenCalledWith(3);
  });

  it("a specific length chooses the typed value", () => {
    const onChoose = vi.fn();
    render(<AudioLengthDialog {...props} onChoose={onChoose} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /specific length/i }));
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(onChoose).toHaveBeenCalledWith(12);
  });

  it("clamps a specific length to the asset's own length", () => {
    const onChoose = vi.fn();
    render(<AudioLengthDialog {...props} onChoose={onChoose} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /specific length/i }));
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "9999" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(onChoose).toHaveBeenCalledWith(229);
  });

  it("Trim fits the REMAINING room when the clip starts mid-piece", () => {
    // A clip dropped at 0.16s with duration == the piece's whole length still
    // ends past the piece and stretches it — the exact silent stretch this
    // dialog exists to prevent. Trim must use pieceDuration - startTime.
    const onChoose = vi.fn();
    render(
      <AudioLengthDialog
        {...props}
        startTimeSec={1}
        onChoose={onChoose}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /trim/i }));
    expect(onChoose).toHaveBeenCalledWith(2);
  });

  it("Trim never returns a negative length when the start is past the end", () => {
    const onChoose = vi.fn();
    render(
      <AudioLengthDialog
        {...props}
        startTimeSec={99}
        onChoose={onChoose}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /trim/i }));
    expect(onChoose).toHaveBeenCalledWith(0);
  });

  it("Cancel writes nothing", () => {
    const onChoose = vi.fn();
    const onCancel = vi.fn();
    render(<AudioLengthDialog {...props} onChoose={onChoose} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(onChoose).not.toHaveBeenCalled();
  });
});
