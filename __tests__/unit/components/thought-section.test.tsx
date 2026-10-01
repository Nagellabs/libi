// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import ThoughtSection from "@/components/chat/thought-section";

afterEach(cleanup);

// What codex-acp streams for a gpt-6 reasoning summary: a "\n\n" section break
// before each title, and titles written as markdown bold. Printed raw, that was a
// tall blank gap under "thinking" and literal ** around every title.
const CODEX_SUMMARY = "\n\n**Checking file metadata**\n\n\n\n**Listing files**";

describe("ThoughtSection", () => {
  it("renders a Codex reasoning summary as markdown, with no leading blank lines", () => {
    const { container } = render(<ThoughtSection text={CODEX_SUMMARY} active />);
    const body = container.querySelector("[data-testid='thought-body']");
    expect(body).not.toBeNull();
    expect(body!.textContent).not.toContain("**");
    const strong = Array.from(body!.querySelectorAll("strong")).map((s) => s.textContent);
    expect(strong).toEqual(["Checking file metadata", "Listing files"]);
    expect(body!.textContent!.startsWith("\n")).toBe(false);
  });

  it("keeps Claude's plain-prose thinking as it was", () => {
    const { container } = render(<ThoughtSection text={"Let me look at the file.\nThen decide."} active={false} />);
    expect(container.querySelector("[data-testid='thought-body']")!.textContent).toContain("Let me look at the file.");
  });

  it("opens a link in thinking in a new tab, never navigating the studio away", () => {
    const { container } = render(<ThoughtSection text={"See [the docs](https://example.com/x)."} active />);
    const a = container.querySelector("[data-testid='thought-body'] a")!;
    expect(a.getAttribute("href")).toBe("https://example.com/x");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
  });
});
