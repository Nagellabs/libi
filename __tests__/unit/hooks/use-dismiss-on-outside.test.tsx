// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { useRef } from "react";
import { useDismissOnOutside } from "@/hooks/use-dismiss-on-outside";

function Menu({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismissOnOutside(ref, onClose);
  return (
    <div ref={ref}>
      <button type="button">inside</button>
    </div>
  );
}

describe("useDismissOnOutside", () => {
  it("closes on Escape and on a press outside, not on a press inside", () => {
    const onClose = vi.fn();
    render(<Menu onClose={onClose} />);
    fireEvent.mouseDown(screen.getByText("inside"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.keyDown(document, { key: "a" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("stops listening after unmount", () => {
    const onClose = vi.fn();
    const { unmount } = render(<Menu onClose={onClose} />);
    unmount();
    fireEvent.mouseDown(document.body);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
