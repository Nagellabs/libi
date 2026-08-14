import { describe, it, expect } from "vitest";
import { renderDialect } from "@/lib/instructions/dialect";

describe("renderDialect", () => {
  it("keeps claude-block content (markers stripped) and drops codex blocks for 'claude'", () => {
    const text = [
      "shared before",
      "<!-- libi-agent:claude -->",
      "claude only",
      "<!-- /libi-agent:claude -->",
      "<!-- libi-agent:codex -->",
      "codex only",
      "<!-- /libi-agent:codex -->",
      "shared after",
    ].join("\n");

    const out = renderDialect(text, "claude");
    expect(out).toContain("shared before");
    expect(out).toContain("claude only");
    expect(out).toContain("shared after");
    expect(out).not.toContain("codex only");
    // marker lines are stripped
    expect(out).not.toContain("libi-agent:claude");
    expect(out).not.toContain("libi-agent:codex");
  });

  it("keeps codex-block content and drops claude blocks for 'codex'", () => {
    const text = [
      "shared before",
      "<!-- libi-agent:claude -->",
      "claude only",
      "<!-- /libi-agent:claude -->",
      "<!-- libi-agent:codex -->",
      "codex only",
      "<!-- /libi-agent:codex -->",
      "shared after",
    ].join("\n");

    const out = renderDialect(text, "codex");
    expect(out).toContain("shared before");
    expect(out).toContain("codex only");
    expect(out).toContain("shared after");
    expect(out).not.toContain("claude only");
    expect(out).not.toContain("libi-agent:claude");
    expect(out).not.toContain("libi-agent:codex");
  });

  it("unmarked text always survives both dialects", () => {
    const text = "line a\nline b\nline c";
    expect(renderDialect(text, "claude")).toBe(text);
    expect(renderDialect(text, "codex")).toBe(text);
  });

  it("is identity on marker-free text (idempotent)", () => {
    const text = "just some\nregular text with no markers";
    const once = renderDialect(text, "claude");
    expect(once).toBe(text);
    expect(renderDialect(once, "claude")).toBe(once);
  });

  it("handles multiple separate blocks of the same dialect", () => {
    const text = [
      "<!-- libi-agent:codex -->A<!-- /libi-agent:codex -->",
      "mid",
      "<!-- libi-agent:codex -->B<!-- /libi-agent:codex -->",
    ].join("\n");
    const out = renderDialect(text, "codex");
    expect(out).toContain("A");
    expect(out).toContain("mid");
    expect(out).toContain("B");
    const claudeOut = renderDialect(text, "claude");
    expect(claudeOut).not.toContain("A");
    expect(claudeOut).not.toContain("B");
    expect(claudeOut).toContain("mid");
  });

  it("throws on an unclosed marker", () => {
    const text = "<!-- libi-agent:claude -->\nunclosed";
    expect(() => renderDialect(text, "claude")).toThrow();
  });

  it("throws on a stray closing marker with no opener", () => {
    const text = "stray\n<!-- /libi-agent:codex -->";
    expect(() => renderDialect(text, "codex")).toThrow();
  });

  it("throws on nested markers", () => {
    const text = [
      "<!-- libi-agent:claude -->",
      "<!-- libi-agent:codex -->",
      "x",
      "<!-- /libi-agent:codex -->",
      "<!-- /libi-agent:claude -->",
    ].join("\n");
    expect(() => renderDialect(text, "claude")).toThrow();
  });

  it("throws on a mismatched closer (claude opened, codex closed)", () => {
    const text = [
      "<!-- libi-agent:claude -->",
      "x",
      "<!-- /libi-agent:codex -->",
    ].join("\n");
    expect(() => renderDialect(text, "claude")).toThrow();
  });
});
