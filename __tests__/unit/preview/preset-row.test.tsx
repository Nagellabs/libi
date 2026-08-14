// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// Capture the mutate fns so assertions can inspect calls. The REAL matchPreset
// is used (only the query hooks are mocked) so the active chip is computed.
const applyMutate = vi.fn();
const saveMutate = vi.fn();
const delMutate = vi.fn();

const PRESETS = [
  { id: "clean", name: "Clean", kind: "text", source: "bundled", fields: { color: "#ffffff" } },
  { id: "gold", name: "Gold", kind: "text", source: "user", fields: { color: "#ffd400" } },
];

vi.mock("@/lib/queries/overlay-presets", () => ({
  useOverlayPresets: () => ({ data: PRESETS, isLoading: false }),
  useApplyPreset: () => ({ mutate: applyMutate }),
  useSavePreset: () => ({ mutate: saveMutate }),
  useDeletePreset: () => ({ mutate: delMutate }),
}));

import { PresetRow } from "@/components/preview/preset-row";

afterEach(() => {
  cleanup();
  applyMutate.mockClear();
  saveMutate.mockClear();
  delMutate.mockClear();
});

// Overlay color matches gold's pinned field → gold is the active preset.
const textOverlay = {
  id: "o1",
  kind: "text" as const,
  startTime: 0,
  duration: 1,
  z: 0,
  rect: { x: 0, y: 0, width: 100, height: 50 },
  opacity: 1,
  content: "Hi",
  font: "48px Inter",
  color: "#ffd400",
  align: "left" as const,
};

describe("PresetRow (text)", () => {
  it("renders both preset chips", () => {
    render(<PresetRow overlay={textOverlay} pieceId="p" />);
    expect(document.querySelector('[data-preset="clean"]')).toBeInTheDocument();
    expect(document.querySelector('[data-preset="gold"]')).toBeInTheDocument();
  });

  it("offers a Save preset affordance", () => {
    render(<PresetRow overlay={textOverlay} pieceId="p" />);
    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
  });

  it("applies the clicked preset with the right args", () => {
    render(<PresetRow overlay={textOverlay} pieceId="p" />);
    fireEvent.click(document.querySelector('[data-preset="gold"]')!);
    expect(applyMutate).toHaveBeenCalledTimes(1);
    expect(applyMutate).toHaveBeenCalledWith(
      expect.objectContaining({ overlayId: "o1", presetId: "gold", kind: "text" }),
    );
  });

  it("marks the matching preset chip active", () => {
    render(<PresetRow overlay={textOverlay} pieceId="p" />);
    const goldChip = document.querySelector('[data-preset="gold"]')!;
    expect(goldChip.getAttribute("aria-pressed")).toBe("true");
    const cleanChip = document.querySelector('[data-preset="clean"]')!;
    expect(cleanChip.getAttribute("aria-pressed")).toBe("false");
  });
});
