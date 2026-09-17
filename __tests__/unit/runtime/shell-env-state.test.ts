import { describe, it, expect } from "vitest";
import { SHELL_ENV_STATE_VAR, isShellEnvLoaded, readShellEnvState } from "@/lib/runtime/shell-env-state";
import { SHELL_ENV_STATE_VAR as SHELL_SIDE } from "../../../electron/path-bootstrap";

describe("the shell→runtime environment seam", () => {
  it("both sides name the same variable", () => {
    expect(SHELL_ENV_STATE_VAR).toBe("LIBI_SHELL_ENV");
    expect(SHELL_SIDE).toBe(SHELL_ENV_STATE_VAR);
  });
  it("absent means inherited from a real shell (npx, dev, Windows) and counts as loaded", () => {
    expect(readShellEnvState({})).toBe("inherited");
    expect(isShellEnvLoaded({})).toBe(true);
  });
  it("loaded is loaded; pending and failed are not", () => {
    expect(isShellEnvLoaded({ LIBI_SHELL_ENV: "loaded" })).toBe(true);
    expect(readShellEnvState({ LIBI_SHELL_ENV: "pending" })).toBe("pending");
    expect(isShellEnvLoaded({ LIBI_SHELL_ENV: "pending" })).toBe(false);
    expect(isShellEnvLoaded({ LIBI_SHELL_ENV: "failed" })).toBe(false);
  });
  it("an unrecognised value is failed — never loaded", () => {
    expect(readShellEnvState({ LIBI_SHELL_ENV: "yes" })).toBe("failed");
    expect(isShellEnvLoaded({ LIBI_SHELL_ENV: "" })).toBe(false);
  });
});
