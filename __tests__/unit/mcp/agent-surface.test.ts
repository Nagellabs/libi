import { describe, it, expect, afterEach } from "vitest";
import {
  AGENT_SURFACE_ENV,
  currentAgentSurface,
  isInAppSurface,
  inAppSurfaceEnvEntry,
} from "@/lib/mcp/agent-surface";

describe("agent-surface utility", () => {
  const ORIG = process.env[AGENT_SURFACE_ENV];
  afterEach(() => {
    if (ORIG === undefined) delete process.env[AGENT_SURFACE_ENV];
    else process.env[AGENT_SURFACE_ENV] = ORIG;
  });

  it("reports in-app only when the flag is exactly 'in-app'", () => {
    process.env[AGENT_SURFACE_ENV] = "in-app";
    expect(currentAgentSurface()).toBe("in-app");
    expect(isInAppSurface()).toBe(true);
  });

  it("defaults to cli when unset (conservative — no in-app leak)", () => {
    delete process.env[AGENT_SURFACE_ENV];
    expect(currentAgentSurface()).toBe("cli");
    expect(isInAppSurface()).toBe(false);
  });

  it("treats any other value as cli", () => {
    process.env[AGENT_SURFACE_ENV] = "terminal";
    expect(isInAppSurface()).toBe(false);
  });

  it("inAppSurfaceEnvEntry is the {name,value} pair injected on the ACP channel", () => {
    expect(inAppSurfaceEnvEntry()).toEqual({
      name: "LIBI_AGENT_SURFACE",
      value: "in-app",
    });
  });
});
