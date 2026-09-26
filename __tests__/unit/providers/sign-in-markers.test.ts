// The lines libi's setup scripts print around Claude Code's `mcp login`, and the reader that finds them in a setup
// terminal's output (lib/providers/sign-in-markers.ts). The scripts' side is run in setup-commands.test.ts.
import { describe, it, expect } from "vitest";
import { createSignInMarkerReader, signInMarkerLine } from "@/lib/providers/sign-in-markers";

describe("the sign-in marker reader", () => {
  it("finds both lines, in order, among the rest of the output", () => {
    const read = createSignInMarkerReader();
    const out = `$ sh add-provider.sh elevenlabs claude /u/bin/claude\r\nClaude Code adds ElevenLabs…\r\n${signInMarkerLine("start", "elevenlabs")}\r\nAdded HTTP MCP server\r\n${signInMarkerLine("end", "elevenlabs")}\r\n$ `;
    expect(read(out)).toEqual([
      { phase: "start", entry: "elevenlabs" },
      { phase: "end", entry: "elevenlabs" },
    ]);
    // Each is reported once.
    expect(read("more output\r\n")).toEqual([]);
  });

  it("finds a line split across chunks, and one a terminal painted with escape sequences in between", () => {
    const read = createSignInMarkerReader();
    expect(read("[libi sign-in st")).toEqual([]);
    expect(read("art: elevenlabs]\r\n")).toEqual([{ phase: "start", entry: "elevenlabs" }]);
    expect(read("\x1b[32m[libi sign-in \x1b[0mend: \x1b]0;title\x07elevenlabs\x1b[")).toEqual([]);
    expect(read("K]\r\n")).toEqual([{ phase: "end", entry: "elevenlabs" }]);
  });

  it("the command the terminal echoes, and a line that only looks alike, are not markers", () => {
    const read = createSignInMarkerReader();
    expect(read("sh /opt/libi/signin-provider.sh elevenlabs claude /u/bin/claude elevenlabs\r\n")).toEqual([]);
    expect(read("[libi sign-in started: elevenlabs]\r\n[libi sign-in end: ]\r\n")).toEqual([]);
  });

  it("keeps only a short tail between chunks, however much is printed", () => {
    const read = createSignInMarkerReader();
    read("x".repeat(100_000) + "[libi sign-in ");
    expect(read("start: a b]")).toEqual([{ phase: "start", entry: "a b" }]);
  });
});
