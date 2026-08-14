// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { GroupField, GroupSection } from "@/components/preview/group-field";

describe("GroupField (exact-group + per-kind applicability)", () => {
  it("text background.color renders ONLY in the style group (null at transform AND text)", () => {
    // transform → null
    {
      const { container } = render(
        <GroupField fieldKey="background.color" kind="text" group="transform">
          <span data-testid="child">X</span>
        </GroupField>,
      );
      expect(container.querySelector('[data-field="background.color"]')).toBeNull();
    }
    // style → rendered
    {
      const { container } = render(
        <GroupField fieldKey="background.color" kind="text" group="style">
          <span data-testid="child">X</span>
        </GroupField>,
      );
      expect(container.querySelector('[data-field="background.color"]')).not.toBeNull();
    }
    // text → null (exact match)
    {
      const { container } = render(
        <GroupField fieldKey="background.color" kind="text" group="text">
          <span data-testid="child">X</span>
        </GroupField>,
      );
      expect(container.querySelector('[data-field="background.color"]')).toBeNull();
    }
  });

  it("text content renders ONLY in the text group (null at transform AND style)", () => {
    for (const group of ["transform", "style"] as const) {
      const { container } = render(
        <GroupField fieldKey="content" kind="text" group={group}>
          <span>X</span>
        </GroupField>,
      );
      expect(container.querySelector('[data-field="content"]')).toBeNull();
    }
    const { container } = render(
      <GroupField fieldKey="content" kind="text" group="text">
        <span>X</span>
      </GroupField>,
    );
    expect(container.querySelector('[data-field="content"]')).not.toBeNull();
  });

  it("rotation for kind=video renders null at every group (not applicable, no throw)", () => {
    for (const group of ["transform", "style", "text"] as const) {
      const { container } = render(
        <GroupField fieldKey="rotation" kind="video" group={group}>
          <span>X</span>
        </GroupField>,
      );
      expect(container.querySelector('[data-field="rotation"]')).toBeNull();
    }
  });

  it("renders transform-group fields at the transform group for the right kind", () => {
    const { container } = render(
      <GroupField fieldKey="transformPosX" kind="text" group="transform">
        <span data-testid="child">X</span>
      </GroupField>,
    );
    expect(container.querySelector('[data-field="transformPosX"]')).not.toBeNull();
  });

  it("throws for an unknown field key (drift)", () => {
    expect(() =>
      render(
        <GroupField fieldKey="nope.not.real" kind="text" group="style">
          <span>X</span>
        </GroupField>,
      ),
    ).toThrow();
  });

  it("adds the highlight flash marker when the highlight property matches", () => {
    const { container } = render(
      <GroupField
        fieldKey="background.color"
        kind="text"
        group="style"
        highlight={{ property: "background.color", note: "Use this to set the plate color" }}
      >
        <span data-testid="child">X</span>
      </GroupField>,
    );
    const wrap = container.querySelector('[data-field="background.color"]');
    expect(wrap).toHaveAttribute("data-highlight", "true");
    expect(screen.getByText(/plate color/i)).toBeInTheDocument();
  });

  it("does not flash when the highlight property is a different field", () => {
    const { container } = render(
      <GroupField
        fieldKey="background.color"
        kind="text"
        group="style"
        highlight={{ property: "background" }}
      >
        <span data-testid="child">X</span>
      </GroupField>,
    );
    const wrap = container.querySelector('[data-field="background.color"]');
    expect(wrap).not.toHaveAttribute("data-highlight", "true");
  });
});

describe("GroupSection (per-kind, exact-group)", () => {
  it("renders when at least one field key is at the active (kind, group)", () => {
    render(
      <GroupSection
        title="Background"
        fieldKeys={["background", "background.color"]}
        kind="text"
        group="style"
      >
        <span data-testid="body">body</span>
      </GroupSection>,
    );
    expect(screen.getByText("Background")).toBeInTheDocument();
    expect(screen.getByTestId("body")).toBeInTheDocument();
  });

  it("renders nothing when none of its keys are at the active (kind, group)", () => {
    const { container } = render(
      <GroupSection
        title="Background"
        fieldKeys={["background.color", "background.padding"]}
        kind="text"
        group="transform"
      >
        <span data-testid="body">body</span>
      </GroupSection>,
    );
    expect(screen.queryByText("Background")).toBeNull();
    expect(screen.queryByTestId("body")).toBeNull();
    expect(container.firstChild).toBeNull();
  });
});
