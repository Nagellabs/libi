import { describe, it, expect } from "vitest";
import {
  fromAnyToolName,
  normalizeCodexToolTitle,
} from "@/lib/agents/mcp-tool-id";
import { isGenerationTool } from "@/lib/approval/generation";

// ---------------------------------------------------------------------------
// Task 4.5 (G3): codex tool-call label normalization.
//
// LIVE CAPTURE (from `/api/agent/messages`, the `toolId` of a real codex
// `libi.list_pieces` call): the actual codex tool_call title is
// "Tool: libi/libi.list_pieces" — optional `Tool: ` prefix +
// `<server>/<server>.<tool>` where the tail after `/` is the fully-qualified
// dotted MCP tool name (server name appears TWICE). NOT claude's
// `mcp__libi__list_pieces` wire name. Left as-is, the chat card renders
// "Tool libi/libi.list_pieces" because the `mcp__` formatter doesn't match.
// We normalize the codex shapes to the SAME canonical id claude produces so
// both agents render identically ("Libi List pieces").
// ---------------------------------------------------------------------------

describe("normalizeCodexToolTitle", () => {
  it("maps the REAL live shape `Tool: <server>/<server>.<tool>` to the claude wire name", () => {
    expect(normalizeCodexToolTitle("Tool: libi/libi.list_pieces")).toBe(
      "mcp__libi__list_pieces",
    );
    expect(normalizeCodexToolTitle("Tool: fal-ai/fal-ai.generate_image")).toBe(
      "mcp__fal-ai__generate_image",
    );
  });

  it("maps the dotted doubled-server form WITHOUT the `Tool: ` prefix too", () => {
    expect(normalizeCodexToolTitle("libi/libi.list_pieces")).toBe(
      "mcp__libi__list_pieces",
    );
  });

  it("tolerates a `Tool ` prefix without the colon", () => {
    expect(normalizeCodexToolTitle("Tool libi/libi.list_pieces")).toBe(
      "mcp__libi__list_pieces",
    );
  });

  it("maps `<server>/<server> <tool words>` to the claude wire name (defensive)", () => {
    // libi/libi list pieces → mcp__libi__list_pieces
    expect(normalizeCodexToolTitle("libi/libi list pieces")).toBe(
      "mcp__libi__list_pieces",
    );
  });

  it("maps `<server>/<tool>` to the claude wire name", () => {
    expect(normalizeCodexToolTitle("libi/list_pieces")).toBe(
      "mcp__libi__list_pieces",
    );
  });

  it("space-joins multi-word tool titles into snake_case", () => {
    expect(normalizeCodexToolTitle("fal-ai/fal-ai generate image")).toBe(
      "mcp__fal-ai__generate_image",
    );
  });

  it("passes UNKNOWN / plain titles through verbatim (never breaks a label)", () => {
    expect(normalizeCodexToolTitle("Read")).toBe("Read");
    expect(normalizeCodexToolTitle("Bash")).toBe("Bash");
    expect(normalizeCodexToolTitle("some random title")).toBe(
      "some random title",
    );
    // Built-in title with a filesystem path — NOT a fake MCP id.
    expect(normalizeCodexToolTitle("Tool: Read /some/path")).toBe(
      "Tool: Read /some/path",
    );
    // Slashed multi-segment tail is a path, not a tool name.
    expect(normalizeCodexToolTitle("Read/some/path")).toBe("Read/some/path");
    // Prefixed built-in with no slash at all — untouched.
    expect(normalizeCodexToolTitle("Tool: Bash")).toBe("Tool: Bash");
    // Already the claude wire shape — untouched (no slash).
    expect(normalizeCodexToolTitle("mcp__libi__list_pieces")).toBe(
      "mcp__libi__list_pieces",
    );
    // Canonical already — untouched.
    expect(normalizeCodexToolTitle("libi:libi.list_pieces")).toBe(
      "libi:libi.list_pieces",
    );
  });
});

describe("fromAnyToolName — codex shape", () => {
  it("maps the REAL `Tool: libi/libi.list_pieces` to the SAME id as claude's mcp__libi__list_pieces", () => {
    const claude = fromAnyToolName("mcp__libi__list_pieces");
    const codex = fromAnyToolName("Tool: libi/libi.list_pieces");
    expect(codex).toBe(claude);
    expect(codex).toBe("libi:list_pieces");
  });

  it("maps `libi/libi list pieces` to the SAME id as claude's mcp__libi__list_pieces (defensive)", () => {
    const claude = fromAnyToolName("mcp__libi__list_pieces");
    const codex = fromAnyToolName("libi/libi list pieces");
    expect(codex).toBe(claude);
    expect(codex).toBe("libi:list_pieces");
  });

  it("leaves the claude `mcp__x__y` shape UNCHANGED", () => {
    expect(fromAnyToolName("mcp__libi__list_pieces")).toBe("libi:list_pieces");
    expect(fromAnyToolName("mcp__elevenlabs__text_to_speech")).toBe(
      "elevenlabs:text_to_speech",
    );
    expect(fromAnyToolName("mcp__libi__libi.compute_object_track")).toBe(
      "libi:libi.compute_object_track",
    );
  });

  it("passes unknown / built-in titles through verbatim (null id)", () => {
    expect(fromAnyToolName("Read")).toBeNull();
    expect(fromAnyToolName("Bash")).toBeNull();
    expect(fromAnyToolName("some random title")).toBeNull();
    expect(fromAnyToolName("Tool: Read /some/path")).toBeNull();
    expect(fromAnyToolName("Tool: Bash")).toBeNull();
  });
});

describe("generation-tool gating survives codex normalization", () => {
  it("fires isGenerationTool for the REAL codex fal shape `Tool: fal-ai/fal-ai.generate_image`", () => {
    const codex = fromAnyToolName("Tool: fal-ai/fal-ai.generate_image");
    expect(codex).toBe("fal-ai:generate_image");
    expect(isGenerationTool(codex)).toBe(true);
  });

  it("still fires isGenerationTool for the spaced codex fal shape (defensive)", () => {
    const codex = fromAnyToolName("fal-ai/fal-ai generate image");
    expect(codex).toBe("fal-ai:generate_image");
    expect(isGenerationTool(codex)).toBe(true);
  });

  it("matches claude's fal gating for the same tool", () => {
    const claude = fromAnyToolName("mcp__fal-ai__generate_image");
    expect(isGenerationTool(claude)).toBe(true);
  });
});
