import { describe, it, expect } from "vitest";
import {
  launchCommandForPreset,
  launchLineForPreset,
} from "@/lib/terminal/launch-command";
import { TERMINAL_CLI_PRESETS } from "@/lib/terminal/presets";

describe("launchCommandForPreset", () => {
  it("returns the bare 'claude' command for claude-code", () => {
    expect(launchCommandForPreset("claude-code")).toBe("claude");
  });

  it("returns the bare 'codex' command for the codex preset (no -c overrides)", () => {
    expect(launchCommandForPreset("codex")).toBe("codex");
  });

  it("returns null for the plain shell preset", () => {
    expect(launchCommandForPreset("shell")).toBe(null);
  });

  it("returns null for an unknown preset (plain shell)", () => {
    expect(launchCommandForPreset("nope")).toBe(null);
  });

  it("returns null for a now-removed agent preset (falls back to plain shell)", () => {
    expect(launchCommandForPreset("opencode")).toBe(null);
  });
});

/**
 * The preset types its CLI's bare name and never probes the machine: whether
 * the agent is set up is decided on the Agents page, and the "Launch CLI"
 * dropdown disables a preset whose agent is not ready.
 */
describe("launchLineForPreset", () => {
  it("types the bare command for claude-code", () => {
    expect(launchLineForPreset("claude-code")).toEqual({ text: "claude", kind: "command" });
  });

  it("types the bare command for codex", () => {
    expect(launchLineForPreset("codex")).toEqual({ text: "codex", kind: "command" });
  });

  it("types nothing for the plain shell preset", () => {
    expect(launchLineForPreset("shell")).toBeNull();
  });

  it("types nothing for an unknown preset", () => {
    expect(launchLineForPreset("nope")).toBeNull();
  });

  it("never types a shell comment or an install instruction", () => {
    for (const preset of TERMINAL_CLI_PRESETS) {
      const line = launchLineForPreset(preset.id);
      if (!line) continue;
      expect(line.kind, preset.id).toBe("command");
      expect(line.text.startsWith("#"), preset.id).toBe(false);
      expect(line.text, preset.id).not.toMatch(/npm|install/i);
    }
  });
});
