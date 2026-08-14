// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { OverlayErrorBadge } from "@/components/preview/overlay-error-badge";

describe("OverlayErrorBadge", () => {
  it("renders the error label", () => {
    render(<OverlayErrorBadge message="Unexpected token" style={{}} />);
    expect(screen.getByText(/code error/i)).toBeTruthy();
  });

  it("exposes the full message via the title attribute (hover)", () => {
    render(<OverlayErrorBadge message="SyntaxError: Unexpected token )" style={{}} />);
    expect(screen.getByText(/code error/i).getAttribute("title")).toBe(
      "SyntaxError: Unexpected token )",
    );
  });

  it("applies the passed positioning style", () => {
    render(<OverlayErrorBadge message="boom" style={{ left: 12, top: 34 }} />);
    const el = screen.getByText(/code error/i) as HTMLElement;
    expect(el.style.left).toBe("12px");
    expect(el.style.top).toBe("34px");
  });
});
