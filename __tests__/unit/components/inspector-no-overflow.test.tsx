// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { CaptionInspector } from "@/components/preview/caption-inspector";
import type { TextOverlay } from "@/lib/engine/types";

function makeOverlay(over: Partial<TextOverlay> = {}): TextOverlay {
  return {
    id: "o1",
    kind: "text",
    startTime: 0,
    duration: 1,
    z: 0,
    rect: { x: 0, y: 0, width: 100, height: 50 },
    opacity: 1,
    content: "Hello",
    font: "48px Inter",
    color: "#ffffff",
    align: "left",
    ...over,
  };
}

/**
 * Recursively collect all className values from rendered DOM descendants.
 * Used to assert that fixed-width utility classes are not used on inputs/selects.
 */
function collectClassNames(container: HTMLElement): string[] {
  const classes: string[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
  let node: Node | null = walker.currentNode;
  while (node) {
    const el = node as HTMLElement;
    if (el.className && typeof el.className === "string") {
      classes.push(el.className);
    }
    node = walker.nextNode();
  }
  return classes;
}

describe("CaptionInspector — no fixed-width overflow classes", () => {
  it("does not use fixed-width classes (w-32/w-28/w-24/w-16) on input/select elements", () => {
    render(<CaptionInspector overlay={makeOverlay()} onPatch={() => {}} mode="expert" />);
    const root = screen.getByTestId("caption-inspector");

    // Collect all input and select elements and check their classNames
    const inputs = root.querySelectorAll("input, select");
    const offendingFixedWidths: string[] = [];

    for (const el of inputs) {
      const cls = (el as HTMLElement).className;
      if (/\bw-(32|28|24|16)\b/.test(cls)) {
        offendingFixedWidths.push(`${el.tagName.toLowerCase()}[data-testid="${(el as HTMLElement).dataset.testid}"] has class: ${cls}`);
      }
    }

    expect(offendingFixedWidths).toEqual([]);
  });

  it("inspector root does not have overflow-x-auto or overflow-x-scroll", () => {
    render(<CaptionInspector overlay={makeOverlay()} onPatch={() => {}} mode="expert" />);
    const root = screen.getByTestId("caption-inspector");
    const cls = root.className;
    expect(cls).not.toMatch(/overflow-x-auto|overflow-x-scroll/);
  });

  it("all classNames in the inspector tree do not contain fixed-width select/input classes at w-32/w-28/w-24", () => {
    render(
      <CaptionInspector
        overlay={makeOverlay({ background: { color: "rgba(0,0,0,0.6)", padding: 12, radius: 8 } })}
        onPatch={() => {}}
        mode="expert"
      />,
    );
    const root = screen.getByTestId("caption-inspector");
    const allClasses = collectClassNames(root);
    const violations = allClasses.filter((cls) => /\bw-(32|28|24)\b/.test(cls));
    expect(violations).toEqual([]);
  });
});
