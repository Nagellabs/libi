import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const file = path.join(process.cwd(), "mcp", "instructions-core.md");

describe("mcp/instructions-core.md", () => {
  it("stays inside the 1,900-character budget", () => {
    expect(fs.statSync(file).size).toBeLessThanOrEqual(1900);
  });

  it("carries the provider gate and the no-key rule", () => {
    const text = fs.readFileSync(file, "utf-8");
    expect(text).toContain("libi.suggest_provider({ kind })");
    expect(text).toContain("libi generates no media itself");
    expect(text).toMatch(/never stores one, and you never ask for one in chat/);
  });

  it("sends the agent to suggest_provider when the user ASKS whether a provider is available, not only before generating", () => {
    // Found on Windows: asked "is fal.ai available?", the agent answered in prose and no card with buttons showed.
    const text = fs.readFileSync(file, "utf-8");
    // A MEDIA provider: "is the GitHub MCP connected?" has no kind, and suggest_provider only offers libi's catalog.
    expect(text).toMatch(/or asked about a media provider not in your tool list\?/);
    // Only the app draws buttons; a CLI session gets the commands (see provider-tools.ts).
    expect(text).toMatch(/\(in the app: connect buttons\)/);
  });

  it("no longer tells the agent keys are configured in libi", () => {
    expect(fs.readFileSync(file, "utf-8")).not.toMatch(/Keys are configured in libi/);
  });

  it("names tools by their libi. names, never by a wire prefix", () => {
    expect(fs.readFileSync(file, "utf-8")).not.toMatch(/mcp__libi/);
  });
});
