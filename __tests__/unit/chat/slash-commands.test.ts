import { describe, it, expect } from "vitest";
import {
  filterCommands,
  interceptCommand,
  shouldShowPalette,
  completionText,
} from "@/lib/chat/slash-commands";
import type { AvailableCommandInfo } from "@/lib/sessions/usage";

const COMMANDS: AvailableCommandInfo[] = [
  { name: "compact", description: "Compact the conversation", inputHint: "instructions" },
  { name: "model", description: "Switch model", inputHint: null },
  { name: "review", description: "Review code", inputHint: null },
  { name: "mcp:foo", description: "MCP prompt", inputHint: null },
];

describe("filterCommands", () => {
  it("injects the local /clear entry first on empty token", () => {
    const out = filterCommands("/", COMMANDS);
    expect(out[0]).toEqual({
      name: "clear",
      description: "Start a new chat",
      inputHint: null,
      local: true,
    });
    expect(out).toHaveLength(5);
  });

  it("prefix matches rank alone when any exist", () => {
    expect(filterCommands("/co", COMMANDS).map((c) => c.name)).toEqual(["compact"]);
    expect(filterCommands("/cl", COMMANDS).map((c) => c.name)).toEqual(["clear"]);
  });

  it("falls back to substring matches when no prefix match exists", () => {
    expect(filterCommands("/foo", COMMANDS).map((c) => c.name)).toEqual(["mcp:foo"]);
  });

  it("matching is case-insensitive and returns [] when nothing matches", () => {
    expect(filterCommands("/COMP", COMMANDS).map((c) => c.name)).toEqual(["compact"]);
    expect(filterCommands("/zzz", COMMANDS)).toEqual([]);
  });

  it("works with an empty agent list — /clear is still offered", () => {
    expect(filterCommands("/", []).map((c) => c.name)).toEqual(["clear"]);
  });

  it("drops an agent-advertised clear in favor of the local entry", () => {
    const withAgentClear: AvailableCommandInfo[] = [
      { name: "clear", description: "Agent-side clear", inputHint: null },
      { name: "Clear", description: "case variant", inputHint: null },
      ...COMMANDS,
    ];
    const out = filterCommands("/cl", withAgentClear);
    expect(out.map((c) => c.name)).toEqual(["clear"]);
    expect(out[0].local).toBe(true);
  });

  it("prefix matches exclude substring-only candidates", () => {
    const withSubstring: AvailableCommandInfo[] = [
      ...COMMANDS,
      { name: "recompact", description: "contains but not prefixed", inputHint: null },
    ];
    expect(filterCommands("/comp", withSubstring).map((c) => c.name)).toEqual([
      "compact",
    ]);
  });
});

describe("interceptCommand", () => {
  it("intercepts exactly /clear (args ignored)", () => {
    expect(interceptCommand("/clear")).toBe("new-chat");
    expect(interceptCommand("  /clear  ")).toBe("new-chat");
    expect(interceptCommand("/clear everything")).toBe("new-chat");
  });
  it("does not intercept anything else", () => {
    expect(interceptCommand("/clearx")).toBeNull();
    expect(interceptCommand("/compact")).toBeNull();
    expect(interceptCommand("clear")).toBeNull();
    expect(interceptCommand("say /clear")).toBeNull();
  });

  it("any whitespace ends the command token (newline/tab from shift+enter)", () => {
    expect(interceptCommand("/clear\nfoo")).toBe("new-chat");
    expect(interceptCommand("/clear\tfoo")).toBe("new-chat");
  });
});

describe("shouldShowPalette", () => {
  it("opens only when input starts with / and caret is inside the first token", () => {
    expect(shouldShowPalette("/", 1)).toBe(true);
    expect(shouldShowPalette("/com", 4)).toBe(true);
    expect(shouldShowPalette("/com", 2)).toBe(true);
  });
  it("stays closed for caret at 0, past the first token, or non-command text", () => {
    expect(shouldShowPalette("/com", 0)).toBe(false);
    expect(shouldShowPalette("/compact now", 9)).toBe(false);
    expect(shouldShowPalette("hello /com", 10)).toBe(false);
    expect(shouldShowPalette("", 0)).toBe(false);
  });

  it("caret exactly at the first-token boundary (the space) is still inside", () => {
    expect(shouldShowPalette("/compact now", 8)).toBe(true);
  });
});

describe("completionText", () => {
  it("appends a trailing space only when the command takes input", () => {
    expect(
      completionText({ name: "compact", description: "", inputHint: "instructions" }),
    ).toBe("/compact ");
    expect(completionText({ name: "model", description: "", inputHint: null })).toBe(
      "/model",
    );
  });
});
