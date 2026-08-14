import { describe, it, expect } from "vitest";
import { STATIC_BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";

describe("tracking tiering", () => {
  it("tracking-pyenv is a tier-2 dep on libi-tracking, not on libi-core", () => {
    const core = STATIC_BUNDLED_MCP_SERVERS.find((d) => d.id === "libi")!;
    const track = STATIC_BUNDLED_MCP_SERVERS.find((d) => d.id === "libi-tracking")!;
    const coreHas = (core.dependencies ?? []).some(
      (x) => x.binary === "tracking-pyenv" || x.customInstallerId === "tracking-pyenv");
    const trackDep = (track.dependencies ?? []).find(
      (x) => x.binary === "tracking-pyenv" || x.customInstallerId === "tracking-pyenv");
    expect(coreHas).toBe(false);
    expect(trackDep).toBeTruthy();
    expect(trackDep!.installFlow).toBe("tier-2");
  });
});
