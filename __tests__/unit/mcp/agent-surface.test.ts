import { describe, it, expect } from "vitest";
import { surfaceFromHeaders, SURFACE_HEADER } from "@/lib/mcp/agent-surface";

describe("surfaceFromHeaders", () => {
  it("defaults to cli when the header is absent", () => {
    expect(surfaceFromHeaders({})).toBe("cli");
  });
  it("reads in-app from the header, case-insensitive on the value", () => {
    expect(surfaceFromHeaders({ [SURFACE_HEADER]: "in-app" })).toBe("in-app");
    expect(surfaceFromHeaders({ [SURFACE_HEADER]: "In-App" })).toBe("in-app");
  });
  it("treats any other value as cli", () => {
    expect(surfaceFromHeaders({ [SURFACE_HEADER]: "terminal" })).toBe("cli");
    expect(surfaceFromHeaders({ [SURFACE_HEADER]: ["in-app", "cli"] })).toBe("cli");
  });
});
