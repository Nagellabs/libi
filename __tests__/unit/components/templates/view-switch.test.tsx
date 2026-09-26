// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ViewSwitch } from "@/components/templates/templates-page/view-switch";

afterEach(() => cleanup());

describe("ViewSwitch", () => {
  it("renders Cards and List, presses the active one, and reports a click", () => {
    const onChange = vi.fn();
    render(<ViewSwitch value="cards" onChange={onChange} />);
    const group = screen.getByTestId("templates-view-switch");
    expect(group.getAttribute("aria-label")).toBe("View");
    const cards = screen.getByTestId("templates-view-cards");
    const list = screen.getByTestId("templates-view-list");
    expect(cards.textContent).toContain("Cards");
    expect(list.textContent).toContain("List");
    expect(cards.getAttribute("aria-pressed")).toBe("true");
    expect(list.getAttribute("aria-pressed")).toBe("false");
    expect(cards.className).toContain("cursor-pointer");
    expect(list.className).toContain("cursor-pointer");
    fireEvent.click(list);
    expect(onChange).toHaveBeenCalledWith("list");
  });

  it("clicking the active item again keeps it (never an empty choice)", () => {
    const onChange = vi.fn();
    render(<ViewSwitch value="list" onChange={onChange} />);
    fireEvent.click(screen.getByTestId("templates-view-list"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("templates-view-list").getAttribute("aria-pressed")).toBe("true");
  });
});
