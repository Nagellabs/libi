import { describe, it, expect, vi, beforeEach } from "vitest";

const getSettingsMock = vi.fn();
vi.mock("@/lib/db/settings", () => ({
  getSettings: () => getSettingsMock(),
}));

import {
  isTerminalSurfaceActive,
  setTerminalSurfaceActive,
} from "@/lib/terminal/active-surface";

function resetGlobal() {
  delete (globalThis as Record<string, unknown>)["__libiTerminalSurface"];
}

describe("terminal active-surface flag", () => {
  beforeEach(() => {
    resetGlobal();
    getSettingsMock.mockReset();
  });

  it("initializes from preferredAgent === 'terminal' on first read", () => {
    getSettingsMock.mockReturnValue({ preferredAgent: "terminal" });
    expect(isTerminalSurfaceActive()).toBe(true);
  });

  it("initializes false for a non-terminal preferred agent", () => {
    getSettingsMock.mockReturnValue({ preferredAgent: "claude-code" });
    expect(isTerminalSurfaceActive()).toBe(false);
  });

  it("only consults settings once (cached after init)", () => {
    getSettingsMock.mockReturnValue({ preferredAgent: "terminal" });
    isTerminalSurfaceActive();
    isTerminalSurfaceActive();
    expect(getSettingsMock).toHaveBeenCalledTimes(1);
  });

  it("setTerminalSurfaceActive overrides without touching settings", () => {
    getSettingsMock.mockReturnValue({ preferredAgent: "claude-code" });
    setTerminalSurfaceActive(true);
    expect(isTerminalSurfaceActive()).toBe(true);
    expect(getSettingsMock).not.toHaveBeenCalled();
    setTerminalSurfaceActive(false);
    expect(isTerminalSurfaceActive()).toBe(false);
  });

  it("falls back to false when settings throw (pre-migration boot)", () => {
    getSettingsMock.mockImplementation(() => {
      throw new Error("no db yet");
    });
    expect(isTerminalSurfaceActive()).toBe(false);
  });
});
