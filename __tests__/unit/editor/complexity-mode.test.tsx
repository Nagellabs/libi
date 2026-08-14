// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

import { sanitizeInspectorGroup } from "@/lib/editor-state-context";
import { GroupModeSwitcher } from "@/components/preview/group-mode-switcher";

describe("sanitizeInspectorGroup", () => {
  it("passes through valid intent-group values", () => {
    expect(sanitizeInspectorGroup("transform")).toBe("transform");
    expect(sanitizeInspectorGroup("style")).toBe("style");
    expect(sanitizeInspectorGroup("text")).toBe("text");
    expect(sanitizeInspectorGroup("3d")).toBe("3d");
    expect(sanitizeInspectorGroup("anchors")).toBe("anchors");
  });

  it("returns transform for junk (incl. stale tier values)", () => {
    expect(sanitizeInspectorGroup("simple")).toBe("transform");
    expect(sanitizeInspectorGroup("advanced")).toBe("transform");
    expect(sanitizeInspectorGroup("expert")).toBe("transform");
    expect(sanitizeInspectorGroup("")).toBe("transform");
    expect(sanitizeInspectorGroup(null)).toBe("transform");
    expect(sanitizeInspectorGroup(undefined)).toBe("transform");
    expect(sanitizeInspectorGroup(42)).toBe("transform");
    expect(sanitizeInspectorGroup({})).toBe("transform");
  });
});

describe("GroupModeSwitcher (per-kind tabs)", () => {
  it("renders Transform + Anchors tabs for tracked (manual re-anchor tab)", () => {
    render(<GroupModeSwitcher kind="tracked" mode="transform" onChange={vi.fn()} />);
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Transform", "Anchors"]);
    cleanup();
  });

  it("renders Transform + 3D tabs for the universal-3D kinds (image/video/code/three)", () => {
    // Universal-3D: image/video/code gain a place3d-gated 3D group; three's
    // scene transform moved to a 3D group — all now show a Transform/3D tab bar.
    for (const kind of ["image", "video", "code", "three"] as const) {
      render(<GroupModeSwitcher kind={kind} mode="transform" onChange={vi.fn()} />);
      const tabs = screen.getAllByRole("tab");
      expect(tabs).toHaveLength(2);
      expect(screen.getByRole("tab", { name: /transform/i })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /^3d$/i })).toBeInTheDocument();
      cleanup();
    }
  });

  it("renders four tabs for text (Transform/Style/Text/3D)", () => {
    render(<GroupModeSwitcher kind="text" mode="transform" onChange={vi.fn()} />);
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(screen.getByRole("tab", { name: /transform/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^style$/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^text$/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^3d$/i })).toBeInTheDocument();
  });

  it("marks the active tab", () => {
    render(<GroupModeSwitcher kind="text" mode="style" onChange={vi.fn()} />);
    expect(screen.getByRole("tab", { name: /^style$/i })).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByRole("tab", { name: /transform/i })).toHaveAttribute(
      "data-active",
      "false",
    );
  });

  it("clicking Style calls onChange('style')", () => {
    const onChange = vi.fn();
    render(<GroupModeSwitcher kind="text" mode="transform" onChange={onChange} />);
    fireEvent.click(screen.getByRole("tab", { name: /^style$/i }));
    expect(onChange).toHaveBeenCalledWith("style");
  });
});
