import { describe, it, expect } from "vitest";
import { tomlEmitServerTable, escapeString } from "@/lib/codex-config/toml";

describe("tomlEmitServerTable", () => {
  it("emits a stdio block with command, args, and env", () => {
    const out = tomlEmitServerTable("youtube", {
      command: "npx",
      args: ["-y", "@kevinwatt/yt-dlp-mcp"],
      env: { API_KEY: "secret123" },
    });
    expect(out).toBe(
      [
        "[mcp_servers.youtube]",
        'command = "npx"',
        'args = ["-y", "@kevinwatt/yt-dlp-mcp"]',
        'env = { API_KEY = "secret123" }',
      ].join("\n"),
    );
  });

  it("escapes quotes and backslashes inside string values", () => {
    const out = tomlEmitServerTable("weird", {
      command: 'C:\\Program Files\\bin\\thing.exe',
      args: ['arg with "quotes"', "back\\slash"],
    });
    expect(out).toContain('command = "C:\\\\Program Files\\\\bin\\\\thing.exe"');
    expect(out).toContain('args = ["arg with \\"quotes\\"", "back\\\\slash"]');
  });

  it("emits an empty args array when explicitly provided", () => {
    const out = tomlEmitServerTable("svc", {
      command: "/bin/sh",
      args: [],
    });
    expect(out).toContain("args = []");
  });

  it("quotes the table name when it has non-bare characters", () => {
    const out = tomlEmitServerTable("has.dots", { command: "x" });
    expect(out.split("\n")[0]).toBe('[mcp_servers."has.dots"]');
  });

  it("escapes env values with quotes inside the inline table", () => {
    const out = tomlEmitServerTable("svc", {
      command: "x",
      env: { TOKEN: 'a"b' },
    });
    expect(out).toContain('env = { TOKEN = "a\\"b" }');
  });
});

describe("escapeString", () => {
  it("leaves a plain string alone", () => {
    expect(escapeString("hello world")).toBe("hello world");
  });

  it("escapes a single double-quote", () => {
    expect(escapeString('he said "hi"')).toBe('he said \\"hi\\"');
  });

  it("escapes a backslash", () => {
    expect(escapeString("a\\b")).toBe("a\\\\b");
  });

  it("escapes backslash before quote correctly (order matters)", () => {
    // backslash escaped first, then the quote — otherwise the new backslash
    // from the quote-escape would get double-escaped.
    expect(escapeString('"')).toBe('\\"');
    expect(escapeString("\\")).toBe("\\\\");
  });
});
