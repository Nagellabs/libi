import { describe, it, expect } from "vitest";
import {
  TERMINAL_CLI_PRESETS,
  getPreset,
  DEFAULT_TERMINAL_CLI_ID,
} from "@/lib/terminal/presets";

describe("terminal CLI presets", () => {
  it("has unique ids", () => {
    const ids = TERMINAL_CLI_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes a plain shell preset with no command", () => {
    const shell = getPreset("shell");
    expect(shell).toBeDefined();
    expect(shell!.command).toBeNull();
  });

  it("every non-shell preset has a non-empty launch command and install hint", () => {
    for (const p of TERMINAL_CLI_PRESETS) {
      if (p.id === "shell") continue;
      expect(p.command, p.id).toBeTruthy();
      expect(p.command!.trim().length, p.id).toBeGreaterThan(0);
      expect(p.installHint, p.id).toBeTruthy();
    }
  });

  it("exposes exactly shell, claude-code, codex (in that order)", () => {
    const ids = TERMINAL_CLI_PRESETS.map((p) => p.id);
    expect(ids).toEqual(["shell", "claude-code", "codex"]);
  });

  it("does NOT surface untested agent presets", () => {
    const ids = TERMINAL_CLI_PRESETS.map((p) => p.id);
    for (const removed of [
      "opencode",
      "copilot",
      "pi",
      "aider",
      "cursor",
      "goose",
      "qwen",
    ]) {
      expect(ids).not.toContain(removed);
      expect(getPreset(removed)).toBeUndefined();
    }
  });

  it("returns undefined for unknown preset ids", () => {
    expect(getPreset("does-not-exist")).toBeUndefined();
  });

  it("defaults to claude-code", () => {
    expect(DEFAULT_TERMINAL_CLI_ID).toBe("claude-code");
    expect(getPreset(DEFAULT_TERMINAL_CLI_ID)).toBeDefined();
  });
});
