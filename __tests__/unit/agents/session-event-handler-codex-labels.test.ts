import { describe, it, expect } from "vitest";
import {
  fromAnyToolName,
  fromCodexToolCall,
  normalizeCodexToolTitle,
  toolIdForCall,
} from "@/lib/agents/mcp-tool-id";

// ---------------------------------------------------------------------------
// Codex tool-call canonicalization.
//
// LIVE CAPTURE, codex CLI 0.153.4 / codex-acp 1.10.0 (spike S2, 2026-09-09).
// The `session/update` `tool_call` for an MCP tool looks like this:
//
//   title    = "mcp.libi-app.libi.list_pieces"
//   rawInput = { server: "libi-app", tool: "libi.list_pieces", arguments: {} }
//   _meta    = { is_mcp_tool_call: true }
//
// The TITLE is presentation and has now changed shape twice — the 0.4x-era
// adapter emitted "Tool: libi/libi.list_pieces". The `rawInput` pair is a data
// contract, so it is what canonicalization keys on; the title parser is kept
// only as a fallback for a title arriving with no payload beside it.
//
// The previous version of this file asserted `Tool: libi-app/libi-app.<tool>`
// and `mcp__libi__list_pieces` — neither shape has ever been emitted by any
// codex or Claude build. It passed while EVERY codex MCP call in production
// canonicalized to null.
//
// The one canonical answer for this call, whichever agent made it, is
// `libi:libi.list_pieces`: `mcp/server.ts` registers `libi.list_pieces`, and
// the canonical id is `<server-id>:<registered name>`.
// ---------------------------------------------------------------------------

const CANONICAL = "libi:libi.list_pieces";

describe("fromCodexToolCall — the structured payload (the PRIMARY path)", () => {
  it("canonicalizes the live 1.10.0 rawInput for a libi tool", () => {
    expect(
      fromCodexToolCall({
        server: "libi-app",
        tool: "libi.list_pieces",
        arguments: {},
      }),
    ).toBe(CANONICAL);
  });

  it("agrees with the claude wire name for the same call", () => {
    const claude = fromAnyToolName("mcp__libi-app__libi_list_pieces");
    const codex = fromCodexToolCall({
      server: "libi-app",
      tool: "libi.list_pieces",
      arguments: {},
    });
    expect(codex).toBe(claude);
    expect(codex).toBe(CANONICAL);
  });

  it("keeps a user-installed server's segment verbatim", () => {
    expect(
      fromCodexToolCall({ server: "everything", tool: "echo", arguments: { message: "S2-ALIVE" } }),
    ).toBe("everything:echo");
  });

  it("accepts the `_meta.is_mcp_tool_call` marker in place of the arguments key", () => {
    expect(
      fromCodexToolCall({ server: "libi", tool: "libi.generate_music" }, { is_mcp_tool_call: true }),
    ).toBe("libi:libi.generate_music");
  });

  /**
   * The guard that keeps an ordinary tool's OWN arguments from masquerading as
   * codex's MCP envelope — a `Bash`-style call with `{ server, tool }` in its
   * input is not an MCP call, and must not be given an id.
   */
  it("refuses a server/tool pair that is not the codex envelope", () => {
    expect(fromCodexToolCall({ server: "libi", tool: "libi.list_pieces" })).toBeNull();
    expect(fromCodexToolCall({ description: "d", prompt: "p", arguments: {} })).toBeNull();
    expect(fromCodexToolCall({ server: "", tool: "x", arguments: {} })).toBeNull();
    expect(fromCodexToolCall({ server: "a b", tool: "x", arguments: {} })).toBeNull();
    expect(fromCodexToolCall(null)).toBeNull();
    expect(fromCodexToolCall("mcp.libi-app.libi.list_pieces")).toBeNull();
    expect(fromCodexToolCall([{ server: "libi", tool: "t", arguments: {} }])).toBeNull();
  });
});

describe("toolIdForCall — structured first, title as fallback", () => {
  it("uses the payload when both are present", () => {
    expect(
      toolIdForCall("mcp.libi-app.libi.list_pieces", {
        server: "libi-app",
        tool: "libi.list_pieces",
        arguments: {},
      }),
    ).toBe(CANONICAL);
  });

  it("falls back to the title when the payload is absent (replay, progress-only update)", () => {
    expect(toolIdForCall("mcp.libi-app.libi.list_pieces", undefined)).toBe(CANONICAL);
    expect(toolIdForCall("mcp.libi-app.libi.list_pieces", {})).toBe(CANONICAL);
  });

  it("still yields null for a built-in tool, on either path", () => {
    expect(toolIdForCall("Read", { file_path: "/x" })).toBeNull();
    expect(toolIdForCall(null, undefined)).toBeNull();
  });
});

describe("normalizeCodexToolTitle — the FALLBACK title parser", () => {
  it("maps the live 1.10.0 `mcp.<server>.<tool>` shape to the claude wire name", () => {
    expect(normalizeCodexToolTitle("mcp.libi-app.libi.list_pieces")).toBe(
      "mcp__libi-app__libi.list_pieces",
    );
    expect(normalizeCodexToolTitle("mcp.everything.echo")).toBe("mcp__everything__echo");
    // Entry named `libi` (what `libi connect` writes) — the dot split takes the
    // FIRST dot, so the registered `libi.generate_music` survives intact.
    expect(normalizeCodexToolTitle("mcp.libi.libi.generate_music")).toBe(
      "mcp__libi__libi.generate_music",
    );
  });

  /**
   * The older adapter's shape, kept so a user on an earlier codex-acp is not
   * regressed. The tail after the slash is the WHOLE registered tool name —
   * nothing is stripped from it. Stripping a `<server>.` prefix here is what
   * made `Tool: libi/libi.list_pieces` canonicalize to `libi:list_pieces`, an
   * id no runner, gate or label ever matches.
   */
  it("maps the older `<server>/<tool>` shape, keeping the tool name verbatim", () => {
    expect(normalizeCodexToolTitle("Tool: libi/libi.list_pieces")).toBe(
      "mcp__libi__libi.list_pieces",
    );
    expect(normalizeCodexToolTitle("libi/libi.list_pieces")).toBe(
      "mcp__libi__libi.list_pieces",
    );
    expect(normalizeCodexToolTitle("Tool libi/libi.list_pieces")).toBe(
      "mcp__libi__libi.list_pieces",
    );
    expect(normalizeCodexToolTitle("libi-app/libi.list_pieces")).toBe(
      "mcp__libi-app__libi.list_pieces",
    );
  });

  it("space-joins a worded tail into snake_case, stripping nothing", () => {
    expect(normalizeCodexToolTitle("libi/libi list pieces")).toBe(
      "mcp__libi__libi_list_pieces",
    );
  });

  it("passes UNKNOWN / plain titles through verbatim (never breaks a label)", () => {
    expect(normalizeCodexToolTitle("Read")).toBe("Read");
    expect(normalizeCodexToolTitle("Bash")).toBe("Bash");
    expect(normalizeCodexToolTitle("some random title")).toBe("some random title");
    // Built-in title with a filesystem path — NOT a fake MCP id.
    expect(normalizeCodexToolTitle("Tool: Read /some/path")).toBe("Tool: Read /some/path");
    // Slashed multi-segment tail is a path, not a tool name.
    expect(normalizeCodexToolTitle("Read/some/path")).toBe("Read/some/path");
    // Prefixed built-in with no separator at all — untouched.
    expect(normalizeCodexToolTitle("Tool: Bash")).toBe("Tool: Bash");
    // Already the claude wire shape — untouched.
    expect(normalizeCodexToolTitle("mcp__libi__libi_list_pieces")).toBe(
      "mcp__libi__libi_list_pieces",
    );
    // Canonical already — untouched.
    expect(normalizeCodexToolTitle("libi:libi.list_pieces")).toBe("libi:libi.list_pieces");
    // `mcp.` prefix but no second segment, and a slashed tail — not a tool id.
    expect(normalizeCodexToolTitle("mcp.libi")).toBe("mcp.libi");
    expect(normalizeCodexToolTitle("mcp.a/b.c")).toBe("mcp.a/b.c");
  });
});

describe("fromAnyToolName — every codex title shape lands on the claude id", () => {
  it("agrees with claude for the live 1.10.0 title", () => {
    const claude = fromAnyToolName("mcp__libi__libi_list_pieces");
    expect(fromAnyToolName("mcp.libi-app.libi.list_pieces")).toBe(claude);
    expect(fromAnyToolName("mcp.libi.libi.list_pieces")).toBe(claude);
    expect(claude).toBe(CANONICAL);
  });

  it("agrees with claude for the older slash title", () => {
    expect(fromAnyToolName("Tool: libi/libi.list_pieces")).toBe(CANONICAL);
    expect(fromAnyToolName("libi/libi list pieces")).toBe(CANONICAL);
  });

  it("leaves the claude `mcp__x__y` shape UNCHANGED", () => {
    expect(fromAnyToolName("mcp__libi-app__libi.generate_speech")).toBe(
      "libi:libi.generate_speech",
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
