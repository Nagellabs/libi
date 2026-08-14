import { describe, it, expect } from "vitest";
import { buildFakeElevenLabsEntry } from "@/lib/mcp-config";

describe("buildFakeElevenLabsEntry", () => {
  it("spawns the fake-elevenlabs stdio entry via tsx's CLI entry point run through node", () => {
    const entry = buildFakeElevenLabsEntry();
    expect("command" in entry).toBe(true);
    const stdio = entry as { command: string; args?: string[] };
    // node_modules/tsx/dist/cli.mjs via `node`, not the .bin/tsx shim
    // electron-builder never copies — matches buildLibiEntry's resolution
    // (see lib/mcp-config.ts).
    expect(stdio.command).toMatch(/(^|[\\/])node(\.exe)?$/);
    expect(stdio.args?.join(" ")).toContain("tsx/dist/cli.mjs");
    expect(stdio.args?.join(" ")).toContain("mcp/dev/fake-elevenlabs/index.ts");
    expect(stdio.args?.join(" ")).toContain("--tsconfig");
  });
});
