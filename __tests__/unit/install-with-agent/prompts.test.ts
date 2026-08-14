import { describe, expect, it } from "vitest";
import {
  buildInstallPrompt,
  buildRepairPrompt,
} from "@/lib/install-with-agent/prompts";

describe("buildInstallPrompt", () => {
  it("includes both name and id verbatim", () => {
    const result = buildInstallPrompt({
      id: "youtube-downloader",
      name: "YouTube Downloader",
    });
    expect(result).toContain("YouTube Downloader");
    expect(result).toContain("`youtube-downloader`");
  });

  it("wraps id in backticks for special characters", () => {
    const result = buildInstallPrompt({
      id: "libi-tracking",
      name: "Libi Tracking",
    });
    expect(result).toContain("`libi-tracking`");
    expect(result).toBe(
      "Please install the Libi Tracking MCP server (id: `libi-tracking`)."
    );
  });

  it("returns exact format without extras", () => {
    const result = buildInstallPrompt({
      id: "test-id",
      name: "Test Name",
    });
    expect(result).toBe("Please install the Test Name MCP server (id: `test-id`).");
  });
});

describe("buildRepairPrompt", () => {
  it("includes Previous error block when error is non-null and non-empty", () => {
    const result = buildRepairPrompt({
      id: "test-id",
      name: "Test MCP",
      installError: "Connection refused",
    });
    expect(result).toContain("The Test MCP MCP server (id: `test-id`)");
    expect(result).toContain("Previous error:");
    expect(result).toContain("Connection refused");
  });

  it("omits Previous error block when error is null", () => {
    const result = buildRepairPrompt({
      id: "test-id",
      name: "Test MCP",
      installError: null,
    });
    expect(result).not.toContain("Previous error:");
    expect(result).toBe(
      "The Test MCP MCP server (id: `test-id`) failed to install or run. Please diagnose and repair it."
    );
  });

  it("omits Previous error block when error is empty string", () => {
    const result = buildRepairPrompt({
      id: "test-id",
      name: "Test MCP",
      installError: "",
    });
    expect(result).not.toContain("Previous error:");
    expect(result).toBe(
      "The Test MCP MCP server (id: `test-id`) failed to install or run. Please diagnose and repair it."
    );
  });

  it("omits Previous error block when error is whitespace-only", () => {
    const result = buildRepairPrompt({
      id: "test-id",
      name: "Test MCP",
      installError: "   \n  ",
    });
    expect(result).not.toContain("Previous error:");
    expect(result).toBe(
      "The Test MCP MCP server (id: `test-id`) failed to install or run. Please diagnose and repair it."
    );
  });

  it("preserves multiline error messages", () => {
    const errorMsg = "Line 1\nLine 2\nLine 3";
    const result = buildRepairPrompt({
      id: "test-id",
      name: "Test MCP",
      installError: errorMsg,
    });
    expect(result).toContain(errorMsg);
  });
});
