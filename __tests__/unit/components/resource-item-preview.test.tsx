// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import ResourceItem from "@/components/resources/resource-item";
import type { FileRecord } from "@/lib/db/schema/types";

/**
 * The hover preview's anchor rect is measured in the hover TIMER (an event
 * context where reading refs is allowed) and passed to ResourcePreview as a
 * prop — the preview derives its position purely, with no mount-effect
 * measurement. These tests pin the show-after-300ms / hide-on-leave contract.
 */

const file = {
  id: "f1",
  name: "clip",
  filename: "clip.png",
  contentType: "image/png",
  size: 1234,
  createdAt: new Date(),
  notes: null,
} as unknown as FileRecord;

describe("ResourceItem hover preview", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function renderItem() {
    return render(
      <ResourceItem
        file={file}
        pieceId="p1"
        isSelected={false}
        onSelect={() => {}}
        onDelete={() => {}}
      />,
    );
  }

  it("shows the preview only after the 300ms hover delay", () => {
    renderItem();
    const row = screen.getByText("clip").closest("div.group")!;
    fireEvent.mouseEnter(row);
    expect(document.querySelector("img[alt='clip']")).toBeNull();

    act(() => vi.advanceTimersByTime(300));
    expect(document.querySelector("img[alt='clip']")).not.toBeNull();
  });

  it("cancels the pending preview when the pointer leaves early", () => {
    renderItem();
    const row = screen.getByText("clip").closest("div.group")!;
    fireEvent.mouseEnter(row);
    act(() => vi.advanceTimersByTime(200));
    fireEvent.mouseLeave(row);
    act(() => vi.advanceTimersByTime(1000));
    expect(document.querySelector("img[alt='clip']")).toBeNull();
  });

  it("hides the preview on mouse leave", () => {
    renderItem();
    const row = screen.getByText("clip").closest("div.group")!;
    fireEvent.mouseEnter(row);
    act(() => vi.advanceTimersByTime(300));
    expect(document.querySelector("img[alt='clip']")).not.toBeNull();

    fireEvent.mouseLeave(row);
    expect(document.querySelector("img[alt='clip']")).toBeNull();
  });
});
