import { describe, it, expect } from "vitest";
import { launchCommandForPreset } from "@/lib/terminal/launch-command";

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
