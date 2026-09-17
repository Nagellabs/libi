import { describe, it, expect } from "vitest";
import { cliUnavailableReason } from "@/lib/agents/cli/unavailable-reason";

describe("cliUnavailableReason — what a refused spawn and a disabled row say", () => {
  it("null for a usable CLI", () => {
    expect(cliUnavailableReason("codex", { path: "/c", realPath: "/c", execPath: "/c", version: "1.0.0", meetsMinimum: true })).toBeNull();
  });
  it("points at the Agents tab for missing, broken and outdated CLIs", () => {
    expect(cliUnavailableReason("codex", null)).toEqual({ code: "not_installed", message: "Codex isn't set up yet — open Agents to install it." });
    expect(cliUnavailableReason("claude-code", { foundButBroken: true, path: "/x" })).toEqual({ code: "install_failed", message: "Claude Code was found at /x but won't run — open Agents.", detail: "found but won't run" });
    expect(cliUnavailableReason("claude-code", { path: "/x", realPath: "/x", execPath: "/x", version: "1.0.0", meetsMinimum: false })).toEqual({ code: "not_installed", message: "Claude Code 1.0.0 is older than libi needs — open Agents to update it.", detail: "below minimum" });
  });
});
