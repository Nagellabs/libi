// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CaptionStyleGrid } from "@/components/preview/caption-style-grid";
import { CAPTION_STYLES, styleToFields } from "@/lib/captions/styles";
import type { TextOverlay } from "@/lib/engine/types";

/** A minimal text overlay with no caption-style look applied. */
const baseOverlay: TextOverlay = {
  id: "t1",
  kind: "text",
  content: "Hello",
  rect: { x: 0, y: 0, w: 0.5, h: 0.2 },
  startTime: 0,
  duration: 2,
  z: 0,
  color: "#ffffff",
} as unknown as TextOverlay;

beforeEach(() => {
  // jsdom's getContext returns null by default — the grid paints each tile once
  // in a plain effect (no rAF loop) and must not throw when ctx is null. rAF is
  // stubbed defensively in case any dependency reaches for it.
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1) as unknown as typeof requestAnimationFrame,
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CaptionStyleGrid", () => {
  it("renders one tile (button) per CAPTION_STYLES entry with the right aria-labels", () => {
    render(<CaptionStyleGrid overlay={baseOverlay} onApplyStyle={() => {}} />);

    const tiles = screen.getAllByRole("button");
    expect(tiles).toHaveLength(CAPTION_STYLES.length);

    for (const style of CAPTION_STYLES) {
      const tile = screen.getByRole("button", { name: style.label });
      expect(tile).toBeInTheDocument();
      expect(tile).toHaveAttribute("data-style", style.id);
    }
  });

  it("clicking a tile calls onApplyStyle with the clicked style id", () => {
    const onApplyStyle = vi.fn();
    render(<CaptionStyleGrid overlay={baseOverlay} onApplyStyle={onApplyStyle} />);

    const target = CAPTION_STYLES.find((s) => s.id === "boxed")!;
    fireEvent.click(screen.getByRole("button", { name: target.label }));

    expect(onApplyStyle).toHaveBeenCalledTimes(1);
    expect(onApplyStyle).toHaveBeenCalledWith("boxed");
  });

  it("highlights the tile whose look matches the overlay's current fields", () => {
    // Apply the "boxed" style's fields onto the overlay → "boxed" tile active.
    const boxedFields = styleToFields("boxed") as Partial<TextOverlay>;
    const overlay = { ...baseOverlay, ...boxedFields } as TextOverlay;

    render(<CaptionStyleGrid overlay={overlay} onApplyStyle={() => {}} />);

    const boxedTile = screen.getByRole("button", {
      name: CAPTION_STYLES.find((s) => s.id === "boxed")!.label,
    });
    expect(boxedTile).toHaveAttribute("data-active", "true");
    expect(boxedTile).toHaveAttribute("aria-pressed", "true");
  });

  it("groups user styles under a 'Your styles' separator, below the bundled ones", () => {
    const userStyle = {
      id: "sunset-pop",
      label: "Sunset Pop",
      source: "user",
      color: "#ff7a1a",
    } as unknown as (typeof CAPTION_STYLES)[number];
    const merged = [...CAPTION_STYLES, userStyle];

    render(
      <CaptionStyleGrid overlay={baseOverlay} onApplyStyle={() => {}} styles={merged} />,
    );

    // Separator appears + a dedicated custom grid holds ONLY the user style.
    expect(screen.getByText(/your styles/i)).toBeInTheDocument();
    const custom = document.querySelector('[data-testid="caption-style-grid-custom"]')!;
    const customIds = Array.from(custom.querySelectorAll("[data-style]")).map((el) =>
      el.getAttribute("data-style"),
    );
    expect(customIds).toEqual(["sunset-pop"]);

    // The bundled grid holds the curated set and NOT the user style.
    const bundled = document.querySelector('[data-testid="caption-style-grid"]')!;
    const bundledIds = Array.from(bundled.querySelectorAll("[data-style]")).map((el) =>
      el.getAttribute("data-style"),
    );
    expect(bundledIds).not.toContain("sunset-pop");
    expect(bundledIds.length).toBe(CAPTION_STYLES.length);
  });

  it("shows NO separator when there are no user styles", () => {
    render(<CaptionStyleGrid overlay={baseOverlay} onApplyStyle={() => {}} />);
    expect(screen.queryByText(/your styles/i)).toBeNull();
    expect(
      document.querySelector('[data-testid="caption-style-grid-custom"]'),
    ).toBeNull();
  });

  it("does not throw when getContext returns null (jsdom)", () => {
    // Real rAF so the loop body executes at least once; getContext is null in
    // jsdom, so the draw must be guarded.
    vi.unstubAllGlobals();
    expect(() =>
      render(<CaptionStyleGrid overlay={baseOverlay} onApplyStyle={() => {}} />),
    ).not.toThrow();
  });
});
