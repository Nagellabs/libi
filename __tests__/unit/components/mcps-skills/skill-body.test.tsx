// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SkillBody } from "@/components/mcps-skills/skill-detail/skill-body";

/**
 * Link extraction now walks matchAll (which clones the regex) instead of
 * exec() against the shared module-level LINK_RE — render never mutates
 * module state. These tests pin the three link renderings, twice in a row
 * to prove repeat renders see every match (a stale shared lastIndex would
 * drop matches on the second pass).
 */
describe("SkillBody", () => {
  const prompts = [{ relPath: "prompts/model-x.md" }];
  const text =
    "See [the model](model-x.md) and [docs](https://example.com) and [gone](other-skill/nope.md).";

  function renderBody(onOpenRef = vi.fn()) {
    render(<SkillBody text={text} prompts={prompts} onOpenRef={onOpenRef} />);
    return onOpenRef;
  }

  it("renders in-skill refs as buttons that navigate", () => {
    const onOpenRef = renderBody();
    fireEvent.click(screen.getByRole("button", { name: "the model" }));
    expect(onOpenRef).toHaveBeenCalledWith("prompts/model-x.md");
  });

  it("renders external URLs as new-tab anchors and unresolved refs as inert spans", () => {
    renderBody();
    const a = screen.getByRole("link", { name: "docs" });
    expect(a).toHaveAttribute("href", "https://example.com");
    expect(a).toHaveAttribute("target", "_blank");
    expect(screen.getByText("gone").tagName).toBe("SPAN");
  });

  it("finds every link again on a second render (no shared-regex state)", () => {
    const { unmount } = render(
      <SkillBody text={text} prompts={prompts} onOpenRef={() => {}} />,
    );
    unmount();
    render(<SkillBody text={text} prompts={prompts} onOpenRef={() => {}} />);
    expect(screen.getByRole("button", { name: "the model" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "docs" })).toBeInTheDocument();
  });
});
