import { describe, it, expect, vi, afterEach } from "vitest";
import {
  launchCommandForPreset,
  launchLineForPreset,
} from "@/lib/terminal/launch-command";

vi.mock("@/lib/terminal/user-cli", () => ({
  resolveUserCli: vi.fn(),
}));
import { resolveUserCli } from "@/lib/terminal/user-cli";
const mockResolve = vi.mocked(resolveUserCli);

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
 * `DEFAULT_TERMINAL_CLI_ID` is `claude-code`, so a user who has never installed
 * it had their FIRST terminal greet them with `claude: command not found` and
 * no hint of what to do — found on a fresh Linux box, 2026-08-16 (F4).
 */
describe("launchLineForPreset", () => {
  afterEach(() => {
    mockResolve.mockReset();
  });

  it("types the command when the user actually has the CLI", () => {
    mockResolve.mockReturnValue("/usr/local/bin/claude");
    expect(launchLineForPreset("claude-code")).toEqual({
      text: "claude",
      kind: "command",
    });
  });

  it("types a shell COMMENT with the install hint when the CLI is missing", () => {
    mockResolve.mockReturnValue(null);
    const line = launchLineForPreset("claude-code");
    expect(line?.kind).toBe("install-hint");
    // Must be inert in bash, zsh AND powershell — the line is written to the
    // shell's STDIN, so anything not commented out would execute.
    expect(line?.text.startsWith("# ")).toBe(true);
    expect(line?.text).toContain("npm i -g @anthropic-ai/claude-code");
    expect(line?.text).toContain("Claude Code");
  });

  it("never emits a bare command as an install hint", () => {
    mockResolve.mockReturnValue(null);
    for (const id of ["claude-code", "codex"]) {
      const line = launchLineForPreset(id);
      expect(line?.kind).toBe("install-hint");
      expect(line?.text.startsWith("#")).toBe(true);
    }
  });

  it("does not probe at all for the plain shell preset", () => {
    expect(launchLineForPreset("shell")).toBeNull();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("returns null for an unknown preset without probing", () => {
    expect(launchLineForPreset("nope")).toBeNull();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("uses the codex preset's own hint, not Claude's", () => {
    mockResolve.mockReturnValue(null);
    expect(launchLineForPreset("codex")?.text).toContain("npm i -g @openai/codex");
  });
});
