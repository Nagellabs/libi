import { describe, it, expect } from "vitest";
import { filmstripBackgroundStyle } from "@/lib/filmstrip/geometry";

describe("filmstripBackgroundStyle", () => {
  it("stretches the sprite to fill the bar height with cover-like sizing", () => {
    const style = filmstripBackgroundStyle({
      barWidthPx: 400,
      frames: 20,
      frameHeightPx: 48,
    });
    // We paint the whole sprite across the bar at bar height.
    expect(style.backgroundSize).toBe("100% 100%");
    expect(style.backgroundRepeat).toBe("no-repeat");
  });

  it("returns a non-repeating background regardless of bar width (zoom-aware)", () => {
    const narrow = filmstripBackgroundStyle({ barWidthPx: 40, frames: 20, frameHeightPx: 48 });
    const wide = filmstripBackgroundStyle({ barWidthPx: 4000, frames: 20, frameHeightPx: 48 });
    expect(narrow.backgroundRepeat).toBe("no-repeat");
    expect(wide.backgroundRepeat).toBe("no-repeat");
    expect(narrow.backgroundSize).toBe("100% 100%");
    expect(wide.backgroundSize).toBe("100% 100%");
  });

  it("is defensive against zero/degenerate inputs", () => {
    const style = filmstripBackgroundStyle({ barWidthPx: 0, frames: 0, frameHeightPx: 0 });
    expect(style.backgroundSize).toBe("100% 100%");
    expect(style.backgroundRepeat).toBe("no-repeat");
  });
});
