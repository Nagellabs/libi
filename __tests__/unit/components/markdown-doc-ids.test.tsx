// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { MarkdownDoc } from "@/components/instructions/markdown-doc";
import { extractSections } from "@/lib/instructions/toc";

const DOC = `# Title

<!-- libi-instructions-start v1.15.0 -->

## MCP Tools

body

## Workflow

body

## Setup

## Setup

<!-- libi-memories-start -->
<!-- libi-memories-end -->
`;

function renderedIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-doc-section]")).map((h) => h.id);
}

const expectedIds = () => extractSections(DOC).map((s) => s.id);

describe("MarkdownDoc heading ids", () => {
  it("match extractSections ids on first render (TOC anchor contract)", () => {
    const { container } = render(<MarkdownDoc content={DOC} />);
    expect(renderedIds(container)).toEqual(expectedIds());
  });

  it("stay stable under StrictMode double-rendering", () => {
    // StrictMode re-invokes renders; ids must be pure (position-derived),
    // not invocation-order-derived — this is the bug that broke TOC clicks.
    const { container } = render(
      <StrictMode>
        <MarkdownDoc content={DOC} />
      </StrictMode>,
    );
    expect(renderedIds(container)).toEqual(expectedIds());
  });

  it("stay stable across re-renders with the same content", () => {
    const { container, rerender } = render(<MarkdownDoc content={DOC} />);
    const first = renderedIds(container);
    rerender(<MarkdownDoc content={DOC} />);
    rerender(<MarkdownDoc content={DOC} />);
    expect(renderedIds(container)).toEqual(first);
    expect(first).toEqual(expectedIds());
  });

  it("hides libi marker comments from the rendered output", () => {
    const { container } = render(<MarkdownDoc content={DOC} />);
    expect(container.textContent).not.toContain("libi-instructions-start");
    expect(container.textContent).not.toContain("libi-memories-start");
  });
});
